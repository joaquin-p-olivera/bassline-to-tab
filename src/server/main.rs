//! HTTP API and web UI for bassline-to-tab.
//!
//! The browser uploads a song to `POST /api/jobs`, then polls
//! `GET /api/jobs/{id}` until the tab is ready. Each job runs the
//! `bassline-to-tab` CLI as a subprocess.

mod jobs;
mod options;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::multipart::MultipartError;
use axum::extract::{DefaultBodyLimit, Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use log::{info, warn};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::jobs::{Config, JobView, Jobs};
use crate::options::JobOptions;

const INDEX_HTML: &str = include_str!("../../web/index.html");
const APP_JS: &str = include_str!("../../web/app.js");

/// Room for the form fields and multipart framing on top of the audio file.
const MULTIPART_OVERHEAD: u64 = 64 * 1024;
const BYTES_PER_MB: u64 = 1024 * 1024;

struct AppState {
    jobs: Arc<Jobs>,
    max_upload_bytes: u64,
}

/// An error answered to the client as `{"error": "..."}`.
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        warn!("Internal error: {error}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    }

    fn queue_full() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "The queue is full, try again in a few minutes")
    }
}

impl From<MultipartError> for ApiError {
    fn from(error: MultipartError) -> Self {
        Self::new(error.status(), error.body_text())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorBody { error: self.message })).into_response()
    }
}

#[derive(Serialize)]
struct Created {
    id: String,
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn app_js() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], APP_JS)
}

async fn health() -> &'static str {
    "ok"
}

/// Streams the multipart form to disk: the audio goes to `<dir>/input.<ext>`,
/// every other field is a transcription option.
async fn receive_upload(
    mut multipart: Multipart,
    dir: &std::path::Path,
    max_bytes: u64,
) -> Result<(JobOptions, PathBuf), ApiError> {
    let mut settings = JobOptions::default();
    let mut input: Option<PathBuf> = None;

    while let Some(mut field) = multipart.next_field().await? {
        let name = field.name().unwrap_or_default().to_string();
        if name != "audio" {
            let value = field.text().await?;
            settings.set_field(&name, &value).map_err(|error| ApiError::bad_request(format!("{name}: {error:#}")))?;
            continue;
        }

        let file_name = field.file_name().unwrap_or_default().to_string();
        let extension = options::audio_extension(&file_name).map_err(|error| ApiError::bad_request(error.to_string()))?;
        let path = dir.join(format!("input.{extension}"));
        let mut file = tokio::fs::File::create(&path).await.map_err(ApiError::internal)?;
        let mut written: u64 = 0;
        while let Some(chunk) = field.chunk().await? {
            written += chunk.len() as u64;
            if written > max_bytes {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("The file is larger than {} MB", max_bytes / BYTES_PER_MB),
                ));
            }
            file.write_all(&chunk).await.map_err(ApiError::internal)?;
        }
        file.flush().await.map_err(ApiError::internal)?;
        if written == 0 {
            return Err(ApiError::bad_request("The audio file is empty"));
        }
        input = Some(path);
    }

    let input = input.ok_or_else(|| ApiError::bad_request("No audio file was uploaded"))?;
    Ok((settings, input))
}

async fn create_job(
    State(state): State<Arc<AppState>>,
    multipart: Multipart,
) -> Result<(StatusCode, Json<Created>), ApiError> {
    if !state.jobs.has_room() {
        return Err(ApiError::queue_full());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = state.jobs.job_dir(&id);
    tokio::fs::create_dir_all(&dir).await.map_err(ApiError::internal)?;

    let queued = match receive_upload(multipart, &dir, state.max_upload_bytes).await {
        Ok((options, input)) => state.jobs.enqueue(id.clone(), options, input).map_err(|_| ApiError::queue_full()),
        Err(error) => Err(error),
    };
    if let Err(error) = queued {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(error);
    }
    info!("Job {id} queued");
    Ok((StatusCode::ACCEPTED, Json(Created { id })))
}

async fn job_status(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Json<JobView>, ApiError> {
    state
        .jobs
        .view(&id)
        .map(Json)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Unknown or expired job"))
}

async fn job_midi(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Result<Response, ApiError> {
    let path = state
        .jobs
        .midi_path(&id)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "No MIDI file for this job"))?;
    let bytes = tokio::fs::read(path).await.map_err(ApiError::internal)?;
    Ok((
        [
            (header::CONTENT_TYPE, "audio/midi"),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"bassline.mid\""),
        ],
        bytes,
    )
        .into_response())
}

/// Reads an environment variable, falling back to `default` when unset or invalid.
fn env_or<T: FromStr>(name: &str, default: T) -> T {
    match std::env::var(name) {
        Ok(value) => value.trim().parse().unwrap_or_else(|_| {
            warn!("Ignoring invalid {name}={value:?}");
            default
        }),
        Err(_) => default,
    }
}

/// The CLI is expected next to the server binary; otherwise it is looked up in `PATH`.
fn default_cli_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("bassline-to-tab")))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("bassline-to-tab"))
}

fn build_router(state: Arc<AppState>) -> Router {
    let upload_limit = usize::try_from(state.max_upload_bytes + MULTIPART_OVERHEAD).unwrap_or(usize::MAX);
    Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/api/health", get(health))
        .route("/api/jobs", post(create_job).layer(DefaultBodyLimit::max(upload_limit)))
        .route("/api/jobs/{id}", get(job_status))
        .route("/api/jobs/{id}/midi", get(job_midi))
        .with_state(state)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::new()
        .filter_level(log::LevelFilter::Warn)
        .filter_module("bassline_to_tab_server", log::LevelFilter::Info)
        .parse_default_env()
        .init();

    let work_dir: PathBuf = env_or("WORK_DIR", std::env::temp_dir().join("bassline-jobs"));
    // Jobs live in memory, so leftovers from a previous run are orphans.
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
    tokio::fs::create_dir_all(&work_dir).await?;

    let config = Config {
        work_dir,
        cli: env_or("BASSLINE_CLI", default_cli_path()),
        max_queue: env_or("MAX_QUEUE", 4),
        job_timeout: Duration::from_secs(env_or("JOB_TIMEOUT_SECS", 3600)),
        result_ttl: Duration::from_secs(env_or("RESULT_TTL_SECS", 3600)),
    };
    info!("Using {} to transcribe", config.cli.display());
    let jobs = Jobs::new(config);
    tokio::spawn(Arc::clone(&jobs).run_worker());
    tokio::spawn(Arc::clone(&jobs).run_sweeper());

    let state = Arc::new(AppState { jobs, max_upload_bytes: env_or("MAX_UPLOAD_MB", 50u64) * BYTES_PER_MB });
    let address = SocketAddr::from(([0, 0, 0, 0], env_or("PORT", 7860u16)));
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!("Listening on http://{address}");
    axum::serve(listener, build_router(state)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}
