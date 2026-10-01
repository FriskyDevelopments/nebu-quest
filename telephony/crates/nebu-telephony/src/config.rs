use crate::token::TokenError;
use url::Url;

/// LiveKit credentials. Debug output never includes the secret.
#[derive(Clone)]
pub struct LiveKitConfig {
    url: Url,
    api_key: String,
    api_secret: String,
}

impl std::fmt::Debug for LiveKitConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveKitConfig")
            .field("url", &self.public_url())
            .field("api_key", &"redacted")
            .finish()
    }
}

impl LiveKitConfig {
    pub fn new(
        url: impl AsRef<str>,
        api_key: impl Into<String>,
        api_secret: impl Into<String>,
    ) -> Result<Self, TokenError> {
        let url = Url::parse(url.as_ref()).map_err(|_| TokenError::BadUrl)?;
        if !matches!(url.scheme(), "wss" | "ws" | "https" | "http") {
            return Err(TokenError::BadUrl);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(TokenError::CredentialsInUrl);
        }
        if url.host_str().unwrap_or("").is_empty() {
            return Err(TokenError::BadUrl);
        }
        let api_key = api_key.into();
        let api_secret = api_secret.into();
        if api_key.trim().is_empty() || api_secret.trim().is_empty() {
            return Err(TokenError::MissingCredentials);
        }
        Ok(Self {
            url,
            api_key,
            api_secret,
        })
    }

    pub fn from_env() -> Result<Self, TokenError> {
        let url = std::env::var("LIVEKIT_URL").map_err(|_| TokenError::MissingCredentials)?;
        let api_key =
            std::env::var("LIVEKIT_API_KEY").map_err(|_| TokenError::MissingCredentials)?;
        let api_secret =
            std::env::var("LIVEKIT_API_SECRET").map_err(|_| TokenError::MissingCredentials)?;
        Self::new(url, api_key, api_secret)
    }

    pub fn signal_url(&self) -> &str {
        self.url.as_str()
    }

    /// Host the control page may show. No userinfo, no secret.
    pub fn public_url(&self) -> String {
        let host = self.url.host_str().unwrap_or("");
        match self.url.port() {
            Some(port) => format!("{}://{}:{}", self.url.scheme(), host, port),
            None => format!("{}://{}", self.url.scheme(), host),
        }
    }

    /// HTTP origin for the LiveKit RoomService (mute, list).
    pub fn service_host(&self) -> String {
        let scheme = match self.url.scheme() {
            "wss" | "https" => "https",
            _ => "http",
        };
        let host = self.url.host_str().unwrap_or("");
        match self.url.port() {
            Some(port) => format!("{scheme}://{host}:{port}"),
            None => format!("{scheme}://{host}"),
        }
    }

    pub(crate) fn api_key(&self) -> &str {
        &self.api_key
    }

    pub(crate) fn api_secret(&self) -> &str {
        &self.api_secret
    }

    pub(crate) fn redact(&self, text: &str) -> String {
        text.replace(self.api_secret.as_str(), "[redacted]")
            .replace(self.api_key.as_str(), "[redacted]")
    }
}
