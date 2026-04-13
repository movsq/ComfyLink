#!/usr/bin/env python3
"""
ComfyLink Setup — interactive configuration wizard.

Run once to generate encryption keys, secrets, and .env files for the project.
Reset by deleting ComfyLink-Setup/build/ and running again.
"""

import sys
import platform
import subprocess
from pathlib import Path

# ─── Paths ────────────────────────────────────────────────────────────────────
SETUP_DIR    = Path(__file__).parent.resolve()
PROJECT_ROOT = SETUP_DIR.parent.resolve()
BUILD_DIR    = SETUP_DIR / "build"
VENV_DIR     = PROJECT_ROOT / ".venv"
IS_WINDOWS   = platform.system() == "Windows"

# ─── Venv bootstrap (runs before any third-party imports) ────────────────────

def _in_venv() -> bool:
    return sys.prefix != sys.base_prefix


def _venv_python() -> Path:
    if IS_WINDOWS:
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def _bootstrap_venv() -> None:
    """Ensure the shared project venv exists and has rich + questionary, then restart."""
    venv_py = _venv_python()

    if not VENV_DIR.exists():
        print(f"[setup] Creating shared virtual environment at {VENV_DIR} ...")
        subprocess.run(
            [sys.executable, "-m", "venv", str(VENV_DIR)],
            check=True,
        )

    print("[setup] Checking setup dependencies (rich, questionary, cryptography) ...")
    subprocess.run(
        [
            str(venv_py), "-m", "pip", "install",
            "rich", "questionary", "cryptography",
            "--quiet",
        ],
        check=True,
    )

    print("[setup] Restarting inside virtual environment ...")
    # subprocess.run + sys.exit is used here instead of os.execv so that the
    # parent process waits for the child and propagates its exit code cleanly
    # on all platforms (os.execv replaces the process image, which can cause
    # issues on Windows when the venv Python path differs from sys.executable).
    result = subprocess.run([str(venv_py)] + sys.argv)
    sys.exit(result.returncode)


if not _in_venv():
    _bootstrap_venv()

# ─── Third-party imports (only reached when inside venv) ─────────────────────

import shutil
import secrets
import time
import base64
import urllib.request
from contextlib import suppress

from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.rule import Rule
from rich import box

import questionary
from questionary import Style

# ─── UI globals ───────────────────────────────────────────────────────────────

console = Console()

QSTYLE = Style([
    ("qmark",       "fg:#7c3aed bold"),
    ("question",    "bold"),
    ("answer",      "fg:#7c3aed bold"),
    ("pointer",     "fg:#7c3aed bold"),
    ("highlighted", "fg:#7c3aed bold"),
    ("selected",    "fg:#7c3aed"),
    ("separator",   "fg:#6b7280"),
    ("instruction", "fg:#6b7280 italic"),
    ("disabled",    "fg:#6b7280 italic"),
])


def _ask(q):
    """Run a questionary prompt and raise KeyboardInterrupt if Ctrl+C was pressed."""
    result = q.ask()
    if result is None:
        raise KeyboardInterrupt
    return result


def q_select(msg: str, choices: list, **kw):
    return _ask(questionary.select(msg, choices=choices, style=QSTYLE, **kw))


def q_text(msg: str, default: str = "", **kw) -> str:
    return _ask(questionary.text(msg, default=default, style=QSTYLE, **kw))


def q_confirm(msg: str, default: bool = True, **kw) -> bool:
    return _ask(questionary.confirm(msg, default=default, style=QSTYLE, **kw))


# ─── Utility helpers ──────────────────────────────────────────────────────────

def rmtree_retry(path: Path) -> None:
    """Remove a directory tree with retries to handle Windows file-lock issues."""
    for _ in range(5):
        with suppress(PermissionError, OSError):
            shutil.rmtree(path)
            return
        time.sleep(0.5)
    shutil.rmtree(path)  # final attempt — raise if still locked


def _npm() -> list[str]:
    """Return the correct npm executable name for the current platform."""
    return ["npm.cmd"] if IS_WINDOWS else ["npm"]


def _check_node() -> None:
    """
    Verify that node and npm are on PATH. Exits with a helpful message if not.
    Called early in Tier 1 flow, before any npm work is attempted.
    """
    errors = []

    for tool, argv in [("node", ["node", "--version"]), ("npm", _npm() + ["--version"])]:
        try:
            r = subprocess.run(argv, capture_output=True, text=True)
            ver = r.stdout.strip() or r.stderr.strip()
            console.print(f"  [dim]{tool:<6}:[/dim] [green]{ver}[/green]")
        except FileNotFoundError:
            errors.append(tool)
            console.print(f"  [dim]{tool:<6}:[/dim] [red]not found[/red]")

    if errors:
        missing = " and ".join(errors)
        console.print()
        console.print(Panel(
            Text.assemble(
                (f"{missing} ", "red bold"),
                ("is not installed or not on your PATH.\n\n", "red"),
                ("Download and install Node.js (npm is included):\n", "bold"),
                ("  https://nodejs.org\n\n", "cyan"),
                ("After installing, restart this terminal and run setup.py again.", "dim"),
            ),
            title="[red]Missing dependency[/red]",
            border_style="red",
            padding=(1, 2),
        ))
        sys.exit(1)


def is_comfyui_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/system_stats", timeout=2
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


# ─── Step functions ── environment status ─────────────────────────────────────

def step_env_status() -> None:
    console.print(Rule("[bold]Environment[/bold]"))
    console.print()
    console.print("[dim]Confirming Python and virtual environment before proceeding.[/dim]\n")
    console.print(f"  [dim]Python   :[/dim] {sys.executable}")
    console.print(f"  [dim]Venv     :[/dim] {sys.prefix}")
    console.print(f"  [dim]Platform :[/dim] {platform.system()} {platform.machine()}")
    console.print()


# ─── Key generation ───────────────────────────────────────────────────────────

def generate_keypair() -> tuple[str, str, str]:
    """
    Generate a P-256 (SECP256R1) keypair matching the browser WebCrypto P-256 curve.
    Returns (private_pem, public_pem, pub_b64_spki_der).
    """
    from cryptography.hazmat.primitives.asymmetric.ec import (
        generate_private_key,
        SECP256R1,
    )
    from cryptography.hazmat.primitives import serialization

    private_key = generate_private_key(SECP256R1())
    public_key  = private_key.public_key()

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    pub_der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    pub_b64 = base64.b64encode(pub_der).decode()

    return private_pem, public_pem, pub_b64


# ─── .env builder ─────────────────────────────────────────────────────────────

def build_env_content(
    deploy_mode:      str,
    pc_secret:        str,
    jwt_secret:       str,
    google_client_id: str,
    comfyui_port:     int,
    server_host:      str,
    server_port:      int,
    invite_required:  bool,
    behind_proxy:     bool,
    allowed_origins:  str,
) -> str:
    lines = [
        "# Generated by ComfyLink Setup",
        "# Do not commit this file to version control.",
        "",
        f"DEPLOY_MODE={deploy_mode}",
        "",
        "# ── PC auth ────────────────────────────────────────────────────────",
        f"PC_SECRET={pc_secret}",
        "",
        *([
            "# ── Google OAuth ────────────────────────────────────────────────────",
            f"GOOGLE_CLIENT_ID={google_client_id}",
            f"VITE_GOOGLE_CLIENT_ID={google_client_id}",
            "",
        ] if google_client_id else []),
        "# ── JWT ─────────────────────────────────────────────────────────────",
        f"JWT_SECRET={jwt_secret}",
        "",
        "# ── Server ──────────────────────────────────────────────────────────",
        f"PORT={server_port}",
        "SESSION_TTL_MS=86400000",
        "",
        "# ── CORS ────────────────────────────────────────────────────────────",
        f"ALLOWED_ORIGINS={allowed_origins}",
        f"BEHIND_PROXY={'true' if behind_proxy else 'false'}",
        "",
        "# ── Storage limits ──────────────────────────────────────────────────",
        "MAX_RESULTS_PER_USER=500",
        "MAX_TOTAL_QUEUE_DEPTH=50",
        "",
        "# ── Access codes ────────────────────────────────────────────────────",
        "ACCESS_CODES_ENABLED=true",
        "",
        "# ── Registration ────────────────────────────────────────────────────",
        f"INVITE_REQUIRED={'true' if invite_required else 'false'}",
        "",
    ]

    if server_host:
        lines += [
            "# ── Host (Caddy / pc-client) ─────────────────────────────────────────",
            f"FLUX_KLEIN_HOST={server_host}",
            "",
        ]

    lines += [
        "# ── TLS (pc-client) ─────────────────────────────────────────────────",
        "SKIP_TLS_VERIFY=false",
        "",
        "# ── ComfyUI (pc-client) ─────────────────────────────────────────────",
        f"COMFYUI_URL=http://127.0.0.1:{comfyui_port}",
        "",
        "# ── PC keypair ───────────────────────────────────────────────────────",
        "PRIVATE_KEY_PATH=pc-client/private_key.pem",
        "PUBLIC_KEY_PATH=pc-client/public_key.pem",
        "",
        "# ── Reconnect ────────────────────────────────────────────────────────",
        "RECONNECT_DELAY=5",
        "",
        "# ── GGUF model ───────────────────────────────────────────────────────",
        "GGUF_MODEL=flux-2-klein-9b-Q4_K_M.gguf",
    ]

    return "\n".join(lines) + "\n"


# ─── Step functions ───────────────────────────────────────────────────────────

def step_welcome() -> None:
    console.print()
    console.print(Panel(
        Text.assemble(
            ("ComfyLink Setup\n\n", "bold #7c3aed"),
            ("ComfyLink lets you generate AI images from any browser.\n", ""),
            ("Your PC runs ComfyUI locally; a relay server handles auth and job queuing.\n", ""),
            ("Prompts and results stay end-to-end encrypted — the server only sees ciphertext.\n\n", ""),
            ("Secure context required: ", "bold yellow"),
            ("WebCrypto only works on https:// or http://localhost.\n", ""),
            ("For phone/remote access, Tailscale is required — plain LAN IPs are not supported.\n\n", "dim"),
            ("This wizard generates encryption keys, secrets, and .env configuration files.\n", "dim"),
            ("Run it again at any time by clearing ComfyLink-Setup/build/ first.", "dim"),
        ),
        box=box.ROUNDED,
        padding=(1, 3),
        border_style="#7c3aed",
    ))
    console.print()


def step_build_check() -> None:
    if not BUILD_DIR.exists():
        return
    if not any(BUILD_DIR.iterdir()):
        return

    console.print(Panel(
        "[yellow]A previous setup run was detected.[/yellow]\n\n"
        f"[dim]Build directory:[/dim] {BUILD_DIR}",
        title="[yellow]Existing build[/yellow]",
        border_style="yellow",
        padding=(1, 2),
    ))
    console.print()

    choice = q_select(
        "What would you like to do?",
        choices=["Clear build and start fresh", "Abort"],
    )
    if choice == "Abort":
        console.print("\n[dim]Aborted.[/dim]")
        sys.exit(0)

    console.print("[dim]Clearing build directory ...[/dim]")
    rmtree_retry(BUILD_DIR)
    console.print("[green]✓[/green] Cleared.\n")


def step_deployment_mode() -> str:
    console.print(Rule("[bold]Deployment Mode[/bold]"))
    console.print()
    console.print(
        "[dim]ComfyLink requires a secure context (HTTPS or localhost).\n"
        "Choose the tier that matches how you want to run the server.[/dim]\n"
    )
    choice = q_select(
        "How are you deploying ComfyLink?",
        choices=[
            "Tier 1 — Local / Private  (server runs on this PC; phone access via Tailscale)",
            "Tier 2 — Public  (server already deployed on a VPS with public DNS or Cloudflare)",
        ],
    )
    console.print()
    return "local" if choice.startswith("Tier 1") else "public"


def step_comfyui() -> int:
    console.print(Rule("[bold]ComfyUI[/bold]"))
    console.print()
    console.print(
        "[dim]ComfyUI is the local image-generation backend. The pc-client forwards\n"
        "decrypted jobs to it and sends the encrypted result back to the relay.[/dim]\n"
    )

    port = 8188
    if is_comfyui_running(port):
        console.print(f"[green]✓[/green] ComfyUI detected on port {port}.\n")
        return port

    console.print("[yellow]![/yellow] ComfyUI not detected on the default port.\n")

    installed = q_confirm("Is ComfyUI installed on this machine?  [Enter = Yes]", default=True)
    if not installed:
        console.print(
            "\nInstall ComfyUI first:\n"
            "  [link]https://github.com/comfyanonymous/ComfyUI[/link]\n"
        )
        input("  Press Enter when ComfyUI is installed and ready to continue ...")
        console.print()

    port_str = q_text("ComfyUI port", default="8188")
    console.print()
    try:
        return int(port_str.strip())
    except (ValueError, TypeError, AttributeError):
        return 8188


def step_generate_keys() -> tuple[str, str, str]:
    console.print(Rule("[bold]PC-Client Encryption Keys[/bold]"))
    console.print()
    console.print(
        "[dim]A P-256 keypair is generated once per installation. The private key\n"
        "never leaves your PC; the server publishes the public key so browsers\n"
        "can encrypt jobs that only your PC can decrypt.[/dim]\n"
    )

    # Warn if keys already exist in pc-client/
    priv_existing = PROJECT_ROOT / "pc-client" / "private_key.pem"
    if priv_existing.exists():
        console.print(
            "[yellow]![/yellow] Existing private_key.pem found in pc-client/.\n"
            "  Continuing will overwrite it. "
            "Back up the existing key if you want to preserve it.\n"
        )
        proceed = q_confirm("Overwrite existing keys?  [Enter = Yes]", default=True)
        if not proceed:
            # Read and return existing keys
            pub_existing  = PROJECT_ROOT / "pc-client" / "public_key.pem"
            private_pem   = priv_existing.read_text()
            public_pem    = pub_existing.read_text() if pub_existing.exists() else ""
            # Derive b64 from existing public key
            try:
                from cryptography.hazmat.primitives.serialization import load_pem_public_key, Encoding, PublicFormat
                pub_key = load_pem_public_key(public_pem.encode())
                der     = pub_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
                pub_b64 = base64.b64encode(der).decode()
            except Exception:
                pub_b64 = "[could not read existing public key]"
            console.print("[dim]Using existing keys.[/dim]\n")
            return private_pem, public_pem, pub_b64

    private_pem, public_pem, pub_b64 = generate_keypair()
    console.print("[green]✓[/green] Keypair generated.\n")

    console.print(Panel(
        Text.assemble(
            ("Public key (base64 SPKI DER)\n\n", "bold"),
            (pub_b64 + "\n\n", "cyan"),
            ("This is the key the server publishes to authenticated clients so\n"
             "they can encrypt jobs destined for your PC.\n"
             "It will be written to pc-client/public_key.pem automatically.", "dim"),
        ),
        border_style="cyan",
        padding=(1, 2),
    ))
    console.print()

    return private_pem, public_pem, pub_b64


def step_secrets() -> tuple[str, str]:
    console.print(Rule("[bold]Secrets[/bold]"))
    console.print()
    console.print(
        "[dim]PC_SECRET authenticates your pc-client to the relay. JWT_SECRET signs\n"
        "user session tokens. Both must be random and kept private.[/dim]\n"
    )
    console.print("[dim]Leave blank to auto-generate a cryptographically secure random value.[/dim]\n")

    pc_raw = questionary.text(
        "PC_SECRET  (shared secret for PC ↔ server auth)",
        style=QSTYLE,
    ).ask()
    if pc_raw is None:
        raise KeyboardInterrupt
    pc_secret = pc_raw.strip() if pc_raw and pc_raw.strip() else secrets.token_hex(32)
    if not (pc_raw and pc_raw.strip()):
        console.print(f"  [dim]Generated PC_SECRET:[/dim] [dim]{pc_secret}[/dim]")

    console.print()

    jwt_raw = questionary.text(
        "JWT_SECRET  (session token signing secret)",
        style=QSTYLE,
    ).ask()
    if jwt_raw is None:
        raise KeyboardInterrupt
    jwt_secret = jwt_raw.strip() if jwt_raw and jwt_raw.strip() else secrets.token_hex(32)
    if not (jwt_raw and jwt_raw.strip()):
        console.print(f"  [dim]Generated JWT_SECRET:[/dim] [dim]{jwt_secret}[/dim]")

    console.print()
    return pc_secret, jwt_secret


def step_auth() -> tuple[str, str]:
    """
    Returns (auth_mode, google_client_id).
    auth_mode: 'google_and_email' | 'email_only' | 'google_only'
    """
    console.print(Rule("[bold]Authentication[/bold]"))
    console.print()
    console.print(
        "[dim]Choose which login methods users can use. Google OAuth requires a\n"
        "Google Cloud project; email/password works standalone.[/dim]\n"
    )

    choice = q_select(
        "Which login methods should be available?",
        choices=[
            "Google OAuth + email/password",
            "Email/password only",
            "Google OAuth only",
        ],
    )
    console.print()

    google_client_id = ""
    if "Google" in choice:
        console.print(
            "[bold]Google OAuth credentials[/bold]\n"
            "[dim]Go to https://console.cloud.google.com → APIs & Services\n"
            "→ Credentials → Create OAuth 2.0 Client ID (Web application).[/dim]\n"
        )
        cid = q_text("Google Client ID")
        google_client_id = cid.strip() if cid else ""
        console.print()

    if choice == "Google OAuth + email/password":
        auth_mode = "google_and_email"
    elif choice == "Email/password only":
        auth_mode = "email_only"
    else:
        auth_mode = "google_only"

    return auth_mode, google_client_id


def step_invite_required() -> bool:
    console.print(Rule("[bold]Registration[/bold]"))
    console.print()
    console.print(
        "[dim]For an initial setup, open registration (no invite required) makes it\n"
        "easier to create your first admin account. You can restrict registration\n"
        "with invite codes later from the admin panel.[/dim]\n"
    )
    invite = q_confirm(
        "Require an invite code to register?  [Enter = No]",
        default=False,
    )
    console.print()
    return invite


def step_server_config_local() -> tuple[str, int, bool, str, bool, str]:
    """
    Tier 1 — Local / Private deployment.
    Returns (server_url, server_port, behind_proxy, allowed_origins, enable_tailscale_tls, server_host).
    server_url is always http://localhost:<port>.
    server_host is set to the Tailscale MagicDNS hostname when remote access is requested.
    """
    console.print(Rule("[bold]Server Configuration[/bold]"))
    console.print()

    port_str = q_text("Server port  (leave blank for 3000)", default="")
    try:
        server_port = int(port_str.strip()) if port_str.strip() else 3000
    except (ValueError, TypeError, AttributeError):
        server_port = 3000

    server_url = f"http://localhost:{server_port}"

    console.print()
    console.print(Panel(
        Text.assemble(
            ("Secure Context — WebCrypto Requirement\n\n", "bold yellow"),
            ("WebCrypto (end-to-end encryption) only works when the browser is served\n"
             "from a ", ""),
            ("secure context", "bold"),
            (" — either ", ""),
            ("https://", "bold cyan"),
            (" or ", ""),
            ("http://localhost", "bold cyan"),
            (".\n\n", ""),
            ("Plain LAN IPs like ", "dim"),
            ("http://192.168.x.x", "dim red"),
            (" are NOT a secure context and will not work.\n\n", "dim"),
            ("Local access on this PC:  ", "dim"),
            (f"http://localhost:{server_port}\n", "cyan"),
            ("Phone / tablet / remote:  ", "dim"),
            ("Tailscale required (see next prompt)", "yellow"),
        ),
        border_style="yellow",
        padding=(1, 2),
    ))
    console.print()

    remote_access = q_confirm(
        "Access ComfyLink from a phone or another device?  (Tailscale required)  [Enter = No]",
        default=False,
    )
    console.print()

    enable_tailscale_tls = False
    server_host = ""

    if remote_access:
        console.print(
            "[dim]Enter your Tailscale MagicDNS hostname \u2014 find it in the Tailscale admin\n"
            "console under DNS \u2192 MagicDNS. It looks like: my-pc.tail1234.ts.net[/dim]\n"
        )
        ts_host = q_text("Tailscale hostname  (e.g. my-pc.tail1234.ts.net)")
        ts_host = ts_host.strip().rstrip("/") if ts_host else ""
        console.print()

        if ts_host:
            server_host = ts_host

            console.print()
            console.print(Panel(
                Text.assemble(
                    ("Tailscale TLS — two options\n\n", "bold yellow"),
                    ("Recommended: ", "bold green"),
                    ("Enable ", ""),
                    ("HTTPS Certificates", "bold"),
                    (" in the Tailscale admin console\n"
                     "   (login.tailscale.com/admin/dns → same page as MagicDNS).\n"
                     "   Tailscale acts as ACME provider → Caddy gets a real Let's Encrypt cert.\n"
                     "   Phone browsers trust it natively. No root CA installation needed.\n\n", ""),
                    ("Alternative: ", "bold yellow"),
                    ("Skip HTTPS Certificates → wizard enables ", ""),
                    ("tls internal", "bold"),
                    (" in the Caddyfile.\n"
                     "   Caddy uses its own self-signed CA. Desktop OK; mobile browsers\n"
                     "   will usually show a certificate warning or block the connection.", ""),
                ),
                border_style="yellow",
                padding=(1, 2),
            ))
            console.print()

            https_certs_enabled = q_confirm(
                "Have you enabled HTTPS Certificates in the Tailscale admin console?  [Enter = Yes]",
                default=True,
            )
            console.print()

            # tls internal is only needed when Tailscale is NOT providing a cert
            enable_tailscale_tls = not https_certs_enabled

            if https_certs_enabled:
                console.print(Panel(
                    Text.assemble(
                        ("Tailscale HTTPS Certificates — enabled\n\n", "bold green"),
                        ("Caddy will auto-provision a real Let's Encrypt certificate\n"
                         "for ", ""),
                        (ts_host, "bold cyan"),
                        (" via Tailscale. No tls internal needed.\n\n", ""),
                        ("Install Tailscale on every phone you want to use:\n", "bold"),
                        ("  https://tailscale.com/download\n\n", "cyan"),
                        ("Then open  ", ""),
                        (f"https://{ts_host}", "bold cyan"),
                        ("  in your browser.\n", ""),
                        ("(Only reachable while connected to your Tailscale network)", "dim"),
                    ),
                    title="[bold]Tailscale \u2014 phone / remote access[/bold]",
                    border_style="green",
                    padding=(1, 2),
                ))
            else:
                console.print(Panel(
                    Text.assemble(
                        ("Tailscale tls internal — self-signed cert\n\n", "bold yellow"),
                        ("The Caddyfile will be patched with ", ""),
                        ("tls internal", "bold"),
                        (" (Caddy's built-in CA).\n\n", ""),
                        ("\u26a0\ufe0f  Most mobile browsers will show a certificate warning\n"
                         "   or refuse to connect. For phone / tablet access,\n"
                         "   enabling Tailscale HTTPS Certificates is strongly recommended.\n\n", "yellow"),
                        ("Install Tailscale on every phone you want to use:\n", "bold"),
                        ("  https://tailscale.com/download\n\n", "cyan"),
                        ("Then open  ", ""),
                        (f"https://{ts_host}", "bold cyan"),
                        ("  in your browser.\n", ""),
                        ("(Only reachable while connected to your Tailscale network)", "dim"),
                    ),
                    title="[bold]Tailscale \u2014 tls internal[/bold]",
                    border_style="yellow",
                    padding=(1, 2),
                ))
            console.print()
        else:
            console.print("[yellow]![/yellow] No hostname entered \u2014 falling back to localhost only.\n")

    behind_proxy = q_confirm(
        "Is the server behind a reverse proxy (Caddy / nginx)?  [Enter = No]",
        default=False,
    )

    # Build ALLOWED_ORIGINS: always localhost + Tailscale host when configured
    origins_parts = [f"http://localhost:{server_port}"]
    if server_host:
        origins_parts.append(f"https://{server_host}")
    allowed_origins = ",".join(origins_parts)

    console.print()
    return server_url, server_port, behind_proxy, allowed_origins, enable_tailscale_tls, server_host


def step_server_config_b() -> tuple[str, str, int]:
    """
    Tier 2 — Public deployment.
    Returns (server_url, server_host, server_port).
    """
    console.print(Rule("[bold]Server Configuration[/bold]"))
    console.print()
    console.print(
        "[dim]The server is already running. Provide its public URL so the\n"
        "pc-client knows where to connect.[/dim]\n"
    )

    server_url = q_text("Server public URL (e.g. https://comfylink.example.com)")
    server_url = server_url.strip() if server_url else ""

    # Extract host for FLUX_KLEIN_HOST
    server_host = (
        server_url
        .replace("https://", "")
        .replace("http://", "")
        .split("/")[0]
    )

    console.print()
    return server_url, server_host, 3000


def step_write_files(
    env_content:         str,
    private_pem:         str,
    public_pem:          str,
    enable_tailscale_tls: bool = False,
) -> None:
    console.print(Rule("[bold]Writing Configuration Files[/bold]"))
    console.print()
    console.print(
        "[dim]Generates .env, keys, and launcher scripts — staged in\n"
        "ComfyLink-Setup/build/ first, then copied to their final destinations.[/dim]\n"
    )

    # ── Stage in build/ ────────────────────────────────────────────────────
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    (BUILD_DIR / ".env").write_text(env_content, encoding="utf-8")

    pc_build = BUILD_DIR / "pc-client"
    pc_build.mkdir(parents=True, exist_ok=True)
    (pc_build / "private_key.pem").write_text(private_pem, encoding="utf-8")
    (pc_build / "public_key.pem").write_text(public_pem,  encoding="utf-8")

    # ── Copy to final destinations ──────────────────────────────────────────
    dest_env  = PROJECT_ROOT / ".env"
    dest_priv = PROJECT_ROOT / "pc-client" / "private_key.pem"
    dest_pub  = PROJECT_ROOT / "pc-client" / "public_key.pem"

    shutil.copy2(BUILD_DIR / ".env",          dest_env)
    shutil.copy2(pc_build  / "private_key.pem", dest_priv)
    shutil.copy2(pc_build  / "public_key.pem",  dest_pub)

    console.print(f"[green]✓[/green] [bold].env[/bold]              → {dest_env}")
    console.print(f"[green]✓[/green] [bold]private_key.pem[/bold]   → {dest_priv}")
    console.print(f"[green]✓[/green] [bold]public_key.pem[/bold]    → {dest_pub}")

    # ── Launcher scripts ───────────────────────────────────────────────────
    _write_launchers()

    # ── Patch Caddyfile for Tailscale TLS ─────────────────────────────────
    if enable_tailscale_tls:
        _patch_caddyfile_tls()

    console.print()


def _write_launchers() -> None:
    """Write run-pc-client and run-server launchers to build/ and project root."""
    pc_bat = (
        "@echo off\r\n"
        "cd /d \"%~dp0\"\r\n"
        ".venv\\Scripts\\python.exe pc-client\\main.py %*\r\n"
    )
    pc_sh = (
        "#!/usr/bin/env bash\n"
        "set -e\n"
        'cd "$(dirname "$0")"\n'
        ".venv/bin/python pc-client/main.py \"$@\"\n"
    )
    server_bat = (
        "@echo off\r\n"
        "cd /d \"%~dp0server\"\r\n"
        "node --env-file=../.env src/index.js\r\n"
    )
    server_sh = (
        "#!/usr/bin/env bash\n"
        "set -e\n"
        'cd "$(dirname "$0")/server"\n'
        "node --env-file=../.env src/index.js\n"
    )

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    (BUILD_DIR / "run-pc-client.bat").write_bytes(pc_bat.encode("utf-8"))
    (BUILD_DIR / "run-pc-client.sh").write_bytes(pc_sh.encode("utf-8"))
    (BUILD_DIR / "run-server.bat").write_bytes(server_bat.encode("utf-8"))
    (BUILD_DIR / "run-server.sh").write_bytes(server_sh.encode("utf-8"))

    for name in ("run-pc-client.bat", "run-pc-client.sh", "run-server.bat", "run-server.sh"):
        dest = PROJECT_ROOT / name
        shutil.copy2(BUILD_DIR / name, dest)

        # Make .sh executable on non-Windows systems
        if not IS_WINDOWS and name.endswith(".sh"):
            import stat
            dest.chmod(dest.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

        console.print(f"[green]✓[/green] [bold]{name}[/bold]")


def _patch_caddyfile_tls() -> None:
    """Uncomment `tls internal` in the Caddyfile to enable Caddy's built-in CA."""
    caddyfile = PROJECT_ROOT / "Caddyfile"
    if not caddyfile.exists():
        console.print("[yellow]![/yellow] Caddyfile not found — skipping TLS patch.\n")
        return
    original = caddyfile.read_text(encoding="utf-8")
    patched  = original.replace("    # tls internal", "    tls internal", 1)
    if patched == original:
        console.print("[dim]Caddyfile: tls internal already enabled or line not found.[/dim]")
    else:
        caddyfile.write_text(patched, encoding="utf-8")
        console.print("[green]✓[/green] [bold]Caddyfile[/bold]         → tls internal enabled")


def step_install_deps_a() -> None:
    console.print(Rule("[bold]Installing Node.js Dependencies[/bold]"))
    console.print()
    console.print("[dim]Installs server and client npm packages locally. Nothing is installed globally.[/dim]\n")

    for label, directory in [("server", PROJECT_ROOT / "server"), ("client", PROJECT_ROOT / "client")]:
        console.print(f"[dim]npm install — {directory.name}/[/dim]")
        result = subprocess.run(
            _npm() + ["install"],
            cwd=str(directory),
        )
        if result.returncode != 0:
            console.print(f"[red]✗[/red] npm install failed in {label}/.")
            retry = q_confirm("Retry?  [Enter = Yes]", default=True)
            if retry:
                subprocess.run(_npm() + ["install"], cwd=str(directory), check=True)
            else:
                console.print("[yellow]Skipping. You can run npm install manually later.[/yellow]")
        else:
            console.print(f"[green]✓[/green] {label}/ dependencies installed.\n")


def step_build_client_a() -> None:
    console.print(Rule("[bold]Building Web Client[/bold]"))
    console.print()
    console.print("[dim]Compiles the Svelte frontend into static files the server will serve.[/dim]\n")
    console.print("[dim]Running vite build ...[/dim]")
    result = subprocess.run(
            _npm() + ["run", "build"],
            cwd=str(PROJECT_ROOT / "client"),
        )
    if result.returncode == 0:
        console.print("[green]✓[/green] Web client built.\n")
    else:
        console.print(
            "[yellow]![/yellow] Client build failed. "
            "Run [bold]npm run build[/bold] inside [bold]client/[/bold] manually.\n"
        )


def step_install_pc_deps() -> None:
    """Install pc-client runtime dependencies into the shared venv."""
    console.print(Rule("[bold]PC-Client Python Dependencies[/bold]"))
    console.print()
    console.print(
        "[dim]Installs websockets, aiohttp, Pillow, cryptography and other packages\n"
        "needed to run the pc-client into the shared virtual environment.[/dim]\n"
    )
    req_file = PROJECT_ROOT / "pc-client" / "requirements.txt"
    if not req_file.exists():
        console.print("[yellow]![/yellow] pc-client/requirements.txt not found — skipping.\n")
        return

    if not q_confirm(
        "Install pc-client Python dependencies into the shared venv?  [Enter = Yes]",
        default=True,
    ):
        console.print(
            "[dim]Skipped. Run manually:\n"
            f"  pip install -r pc-client/requirements.txt[/dim]\n"
        )
        return

    console.print("[dim]Installing ...[/dim]")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(req_file), "--quiet"],
    )
    if result.returncode == 0:
        console.print("[green]✓[/green] PC-client dependencies installed.\n")
    else:
        console.print(
            "[yellow]![/yellow] Some packages failed to install. Run manually:\n"
            "  pip install -r pc-client/requirements.txt\n"
        )


def step_seed_admin_a(server_url: str, server_port: int, enable_tailscale_tls: bool = False, server_host: str = "") -> None:
    console.print(Rule("[bold]Create Admin Account[/bold]"))
    console.print()
    if enable_tailscale_tls and server_host:
        browser_tip = [
            ("   Local (this PC):   ", "dim"),
            (f"http://localhost:{server_port}\n", "cyan"),
            ("   Phone / remote:    ", "dim"),
            (f"https://{server_host}  ", "cyan"),
            ("(must be on Tailscale network)\n\n", "dim"),
        ]
    else:
        browser_tip = [
            ("   URL:  ", "dim"),
            (f"http://localhost:{server_port}\n\n", "cyan"),
        ]
    console.print(Panel(
        Text.assemble(
            ("Setup is done. To finish, create your admin account:\n\n", "bold"),
            ("1. Start the server from the project root:\n", ""),
            ("   node server/src/index.js\n", "cyan"),
            ("   (must be run from project root for correct DB and .env paths)\n\n", "dim"),
            ("   or with Docker Compose:\n", ""),
            ("   docker compose up\n\n", "cyan"),
            ("2. Open your browser:\n", ""),
            *browser_tip,
            ("3. Register your account through the UI\n\n", ""),
            ("4. Run this command from the project root to promote yourself to admin:\n\n", "bold"),
            ("   If running locally:\n", ""),
            ("   node server/src/seed-admin.js your@email.com\n\n", "cyan"),
            ("   If running in Docker:\n", ""),
            ("   docker exec -it <server-container-name> node /app/src/seed-admin.js your@email.com\n", "cyan"),
        ),
        border_style="#7c3aed",
        padding=(1, 2),
    ))
    console.print()


def step_seed_admin_b() -> None:
    console.print(Rule("[bold]Create Admin Account[/bold]"))
    console.print()
    console.print(
        "[dim]Register on the deployed server, then run the command below on that machine\n"
        "to promote your account to admin.[/dim]\n"
    )
    _show_seed_admin_manual()


def _show_seed_admin_manual(email: str = "your@email.com") -> None:
    console.print(Panel(
        Text.assemble(
            ("If running locally (from project root):\n", "bold"),
            (f"  node server/src/seed-admin.js {email}\n\n", "cyan"),
            ("If running in Docker:\n", "bold"),
            (
                f"  docker exec -it <server-container-name> "
                f"node /app/src/seed-admin.js {email}",
                "cyan",
            ),
        ),
        border_style="cyan",
        padding=(1, 2),
    ))
    console.print()


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    try:
        # ── Welcome ────────────────────────────────────────────────────────
        step_welcome()

        # ── Build check ────────────────────────────────────────────────────
        step_build_check()

        # ── Environment status ─────────────────────────────────────────────
        step_env_status()

        # ── Deployment mode ────────────────────────────────────────────────
        mode = step_deployment_mode()

        # ── Node.js pre-flight (Tier 1 only) ─────────────────────────────
        if mode == "local":
            console.print(Rule("[bold]Checking Node.js[/bold]"))
            console.print()
            console.print("[dim]Verifying Node.js and npm are available before continuing.[/dim]\n")
            _check_node()
            console.print()

        # ── ComfyUI ────────────────────────────────────────────────────────
        comfyui_port = step_comfyui()

        # ── PC encryption keys ─────────────────────────────────────────────
        private_pem, public_pem, _pub_b64 = step_generate_keys()

        # ── Shared secrets ─────────────────────────────────────────────────
        pc_secret, jwt_secret = step_secrets()

        # ── Authentication ─────────────────────────────────────────────────
        # auth_mode is intentionally unused: the server infers Google auth
        # from whether GOOGLE_CLIENT_ID is set; there is no AUTH_MODE env var.
        _, google_client_id = step_auth()

        # ── Registration / invite ──────────────────────────────────────────
        invite_required = step_invite_required()

        # ── Server config ──────────────────────────────────────────────────
        server_url      = ""
        server_host     = ""
        server_port     = 3000
        behind_proxy    = False
        allowed_origins = ""
        deploy_mode_env = "local"

        if mode == "local":
            server_url, server_port, behind_proxy, allowed_origins, enable_tailscale_tls, server_host = step_server_config_local()
            deploy_mode_env = "local"
        else:
            server_url, server_host, server_port = step_server_config_b()
            deploy_mode_env = "remote"
            enable_tailscale_tls = False
            allowed_origins = server_url

        # ── Build .env ─────────────────────────────────────────────────────
        env_content = build_env_content(
            deploy_mode      = deploy_mode_env,
            pc_secret        = pc_secret,
            jwt_secret       = jwt_secret,
            google_client_id = google_client_id,
            comfyui_port     = comfyui_port,
            server_host      = server_host,
            server_port      = server_port,
            invite_required  = invite_required,
            behind_proxy     = behind_proxy,
            allowed_origins  = allowed_origins,
        )

        # ── Write all files + launcher scripts ────────────────────────────
        step_write_files(env_content, private_pem, public_pem, enable_tailscale_tls)

        # ── PC-client Python runtime dependencies ─────────────────────────
        step_install_pc_deps()

        # ── Tier 1: install deps + build client ──────────────────────────
        if mode == "local":
            if q_confirm("Install Node.js dependencies now? (npm install)  [Enter = Yes]", default=True):
                step_install_deps_a()

            if q_confirm("Build the web client now? (vite build)  [Enter = Yes]", default=True):
                step_build_client_a()

        # ── Admin seeding ──────────────────────────────────────────────────
        if mode == "local":
            step_seed_admin_a(server_url, server_port, enable_tailscale_tls, server_host)
        else:
            step_seed_admin_b()

        # ── Done ───────────────────────────────────────────────────────────
        console.print(Panel(
            Text.assemble(
                ("Setup complete!\n\n", "bold green"),
                ("All configuration files have been written to their destinations.\n\n", ""),
                ("To start the pc-client:\n", "bold"),
                ("  Windows:  run-pc-client.bat\n", "cyan"),
                ("  Linux:    ./run-pc-client.sh\n\n", "cyan"),
                ("You can close this window.", "dim"),
            ),
            box=box.ROUNDED,
            border_style="green",
            padding=(1, 3),
        ))
        console.print()

    except KeyboardInterrupt:
        console.print("\n\n[dim]Setup interrupted.[/dim]")
        if BUILD_DIR.exists():
            console.print("[dim]Cleaning up partial build ...[/dim]")
            rmtree_retry(BUILD_DIR)
        console.print("[dim]Run setup.py again when ready.[/dim]\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
