#!/usr/bin/env python3
from __future__ import annotations

import ipaddress
import os
import shlex
import socket
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


@dataclass(frozen=True)
class LocalHttpsAssets:
    tls_dir: Path
    ca_key: Path
    ca_cert: Path
    server_key: Path
    server_cert: Path
    primary_ip: str
    san_ips: list[str]


def shell_quote(value: str) -> str:
    return shlex.quote(value)


def detect_primary_ip() -> str:
    explicit = os.getenv("BRAINSESSION_HTTPS_IPS", "").strip()
    if explicit:
        for token in explicit.replace(",", " ").split():
            try:
                parsed = ipaddress.ip_address(token.strip())
            except ValueError:
                continue
            if parsed.version == 4 and not parsed.is_loopback:
                return str(parsed)

    candidates: list[str] = []

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("1.1.1.1", 80))
            candidates.append(sock.getsockname()[0])
    except OSError:
        pass

    try:
        output = subprocess.check_output(["hostname", "-I"], text=True).strip()
        candidates.extend(output.split())
    except Exception:
        pass

    for item in candidates:
        try:
            parsed = ipaddress.ip_address(item)
        except ValueError:
            continue
        if parsed.version == 4 and not parsed.is_loopback and not parsed.is_link_local:
            return str(parsed)

    return "127.0.0.1"


def collect_san_ips(primary_ip: str) -> list[str]:
    san_ips: list[str] = ["127.0.0.1", "::1"]

    for token in os.getenv("BRAINSESSION_HTTPS_IPS", "").replace(",", " ").split():
        try:
            parsed = ipaddress.ip_address(token.strip())
        except ValueError:
            continue
        if str(parsed) not in {"127.0.0.1", "::1"}:
            san_ips.append(str(parsed))

    if primary_ip not in san_ips:
        san_ips.append(primary_ip)

    unique: list[str] = []
    seen: set[str] = set()
    for ip_value in san_ips:
        if ip_value not in seen:
            seen.add(ip_value)
            unique.append(ip_value)
    return unique


def ensure_ca_pair(ca_key: Path, ca_cert: Path) -> None:
    if ca_key.exists() and ca_cert.exists():
        return

    ca_key.parent.mkdir(parents=True, exist_ok=True)

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "BrainSession Local Test Root CA"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "BrainSession Test Lab"),
    ])

    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=False,
            content_commitment=False,
            key_encipherment=False,
            data_encipherment=False,
            key_agreement=False,
            key_cert_sign=True,
            crl_sign=True,
            encipher_only=False,
            decipher_only=False,
        ), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(private_key.public_key()), critical=False)
        .sign(private_key=private_key, algorithm=hashes.SHA256())
    )

    ca_key.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    ca_cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    ca_key.chmod(0o600)


def write_server_pair(assets: LocalHttpsAssets) -> None:
    root_key = serialization.load_pem_private_key(assets.ca_key.read_bytes(), password=None)
    root_cert = x509.load_pem_x509_certificate(assets.ca_cert.read_bytes())

    server_key_obj = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "BrainSession Test Server"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "BrainSession Test Lab"),
    ])

    san_entries: list[x509.GeneralName] = [x509.DNSName("localhost")]
    for ip_value in assets.san_ips:
        try:
            san_entries.append(x509.IPAddress(ipaddress.ip_address(ip_value)))
        except ValueError:
            continue

    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(root_cert.subject)
        .public_key(server_key_obj.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=825))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True,
            content_commitment=False,
            key_encipherment=True,
            data_encipherment=False,
            key_agreement=False,
            key_cert_sign=False,
            crl_sign=False,
            encipher_only=False,
            decipher_only=False,
        ), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.SubjectAlternativeName(san_entries),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(server_key_obj.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()),
            critical=False,
        )
        .sign(private_key=root_key, algorithm=hashes.SHA256())
    )

    assets.server_key.write_bytes(
        server_key_obj.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    assets.server_cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    assets.server_key.chmod(0o600)


def build_assets() -> LocalHttpsAssets:
    root_dir = Path(__file__).resolve().parents[1]
    tls_dir = Path(os.getenv("BRAINSESSION_TLS_DIR", root_dir / "data" / "tls" / "local-test")).expanduser().resolve()
    ca_key = tls_dir / "root-ca.key"
    ca_cert = tls_dir / "root-ca.crt"
    server_key = tls_dir / "server.key"
    server_cert = tls_dir / "server.crt"
    primary_ip = detect_primary_ip()
    san_ips = collect_san_ips(primary_ip)
    return LocalHttpsAssets(
        tls_dir=tls_dir,
        ca_key=ca_key,
        ca_cert=ca_cert,
        server_key=server_key,
        server_cert=server_cert,
        primary_ip=primary_ip,
        san_ips=san_ips,
    )


def main() -> int:
    assets = build_assets()
    assets.tls_dir.mkdir(parents=True, exist_ok=True)
    ensure_ca_pair(assets.ca_key, assets.ca_cert)
    write_server_pair(assets)

    print(f"ROOT_CA_CERT={shell_quote(str(assets.ca_cert))}")
    print(f"SERVER_CERT={shell_quote(str(assets.server_cert))}")
    print(f"SERVER_KEY={shell_quote(str(assets.server_key))}")
    print(f"PRIMARY_IP={shell_quote(assets.primary_ip)}")
    print(f"HTTPS_URL={shell_quote(f'https://{assets.primary_ip}:8443')}")
    print(f"SAN_IPS={shell_quote(','.join(assets.san_ips))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
