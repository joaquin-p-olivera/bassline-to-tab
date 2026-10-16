//! Bass stem separation through the external Demucs CLI.
//!
//! Demucs is a PyTorch model with no practical Rust port, so we run it as a
//! subprocess (`pipx install demucs` or `pip install demucs`).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};
use log::{debug, info};

/// Candidate commands tried, in order, when no explicit command is given.
const DEFAULT_COMMANDS: [&str; 3] = ["demucs", "python3 -m demucs", "python -m demucs"];

fn split_command(command: &str) -> Vec<String> {
    command.split_whitespace().map(str::to_string).collect()
}

fn command_works(parts: &[String]) -> bool {
    let Some((program, args)) = parts.split_first() else {
        return false;
    };
    Command::new(program)
        .args(args)
        .arg("--help")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Finds a working Demucs command, preferring `explicit` when given.
pub fn find_demucs(explicit: Option<&str>) -> Option<Vec<String>> {
    match explicit {
        Some(command) => Some(split_command(command)).filter(|parts| command_works(parts)),
        None => DEFAULT_COMMANDS.iter().map(|c| split_command(c)).find(|parts| command_works(parts)),
    }
}

/// Runs Demucs in two-stem mode and returns the path of the separated bass stem.
pub fn separate_bass(command: &[String], input: &Path, work_dir: &Path, model: &str) -> Result<PathBuf> {
    let (program, base_args) = command.split_first().context("empty Demucs command")?;
    std::fs::create_dir_all(work_dir).with_context(|| format!("cannot create {}", work_dir.display()))?;

    info!("Separating the bass stem with Demucs ({model}); this can take a few minutes on CPU");
    let mut process = Command::new(program);
    process.args(base_args).args(["--two-stems", "bass", "-n", model, "-o"]).arg(work_dir).arg(input);
    debug!("Running {process:?}");
    let status = process.status().with_context(|| format!("failed to start '{program}'"))?;
    if !status.success() {
        bail!("Demucs failed with {status}");
    }

    let track = input.file_stem().context("input file has no name")?;
    let stem = work_dir.join(model).join(track).join("bass.wav");
    if !stem.is_file() {
        bail!("Demucs finished but {} was not created", stem.display());
    }
    info!("Bass stem written to {}", stem.display());
    Ok(stem)
}
