from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_UNSAFE_SECRETS = {"replace-me", "changeme", "secret", "insecure", ""}

ENVIRONMENTS_WITH_DEV_AUTH = {"local", "development"}


class Settings(BaseSettings):
    app_name: str = "SeenSnap API"
    environment: str = "local"
    api_v1_prefix: str = "/api/v1"
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/seensnap"
    tmdb_api_key: str = ""
    tmdb_base_url: str = "https://api.themoviedb.org/3"
    gcp_project_id: str = ""
    gcs_bucket_name: str = ""
    firebase_project_id: str = ""
    apple_bundle_id: str = ""
    google_oauth_client_id: str = ""
    app_auth_secret: str = "replace-me"
    app_auth_audience: str = "seensnap-mobile"
    uploads_dir: str = "uploads"
    share_base_url: str = "https://seensnap.app"
    # Comma-separated list of origins allowed to hit the API from a browser.
    # Empty by default (native app doesn't need CORS). Set on staging/prod to
    # the Netlify preview URL + any custom domains.
    #   e.g. "https://seensnap-alpha.netlify.app,https://alpha.seensnap.com"
    cors_allowed_origins: str = ""
    # Regex fallback for Netlify's per-deploy preview subdomains
    # (deploy-preview-42--seensnap-alpha.netlify.app). Optional.
    cors_allowed_origin_regex: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    def parsed_cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def dev_auth_enabled(self) -> bool:
        return self.environment in ENVIRONMENTS_WITH_DEV_AUTH

    def validate_production_safety(self) -> None:
        """Raise on startup if production environment has unsafe credentials."""
        if self.is_production and self.app_auth_secret in _UNSAFE_SECRETS:
            raise RuntimeError(
                "APP_AUTH_SECRET must be set to a secure value in production. "
                "The current value is a known unsafe placeholder. "
                "Set a random 64-character secret in your environment."
            )

    def uploads_path(self) -> Path:
        configured = Path(self.uploads_dir)
        if configured.is_absolute():
            return configured
        return Path(__file__).resolve().parents[2] / configured


settings = Settings()
