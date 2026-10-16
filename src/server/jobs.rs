//! In-memory job queue. A single worker runs the `bassline-to-tab` CLI for one
//! job at a time, because Demucs already uses every core.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use log::{info, warn};
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::{ChildStderr, Command};
use tokio::sync::Notify;

use crate::options::JobOptions;

/// Longest progress line sent to the browser, in characters.
const MAX_PROGRESS_CHARS: usize = 200;
/// Number of trailing stderr lines kept to explain a failure.
const TAIL_LINES: usize = 10;
/// How often finished jobs are checked for expiry.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

pub struct Config {
    pub work_dir: PathBuf,
    /// Path of the `bassline-to-tab` executable.
    pub cli: PathBuf,
    /// Jobs allowed to wait in the queue (the running one does not count).
    pub max_queue: usize,
    pub job_timeout: Duration,
    /// How long a finished job stays available for download.
    pub result_ttl: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Done,
    Failed,
}

/// What the browser sees of a job.
#[derive(Debug, Serialize)]
pub struct JobView {
    status: Status,
    /// 1 is the next job to run; only set while queued.
    queue_position: Option<usize>,
    progress: String,
    tab: Option<String>,
    error: Option<String>,
    has_midi: bool,
}

struct Job {
    status: Status,
    options: JobOptions,
    dir: PathBuf,
    input: PathBuf,
    progress: String,
    tab: Option<String>,
    error: Option<String>,
    has_midi: bool,
    finished_at: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    jobs: HashMap<String, Job>,
    queue: VecDeque<String>,
}

struct RunOutput {
    tab: String,
    has_midi: bool,
}

/// The queue has no room for another job.
#[derive(Debug)]
pub struct QueueFull;

pub struct Jobs {
    inner: Mutex<Inner>,
    wake: Notify,
    config: Config,
}

impl Jobs {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(Inner::default()), wake: Notify::new(), config })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // The state stays consistent even if a holder panicked, so ignore poisoning.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn job_dir(&self, id: &str) -> PathBuf {
        self.config.work_dir.join(id)
    }

    pub fn has_room(&self) -> bool {
        self.lock().queue.len() < self.config.max_queue
    }

    /// Queues a job whose audio is already saved at `input`. Fails if the queue is full.
    pub fn enqueue(&self, id: String, options: JobOptions, input: PathBuf) -> Result<(), QueueFull> {
        let mut inner = self.lock();
        if inner.queue.len() >= self.config.max_queue {
            return Err(QueueFull);
        }
        let job = Job {
            status: Status::Queued,
            options,
            dir: self.job_dir(&id),
            input,
            progress: String::new(),
            tab: None,
            error: None,
            has_midi: false,
            finished_at: None,
        };
        inner.jobs.insert(id.clone(), job);
        inner.queue.push_back(id);
        drop(inner);
        self.wake.notify_one();
        Ok(())
    }

    pub fn view(&self, id: &str) -> Option<JobView> {
        let inner = self.lock();
        let job = inner.jobs.get(id)?;
        let queue_position = (job.status == Status::Queued)
            .then(|| inner.queue.iter().position(|queued| queued == id).map(|index| index + 1))
            .flatten();
        Some(JobView {
            status: job.status,
            queue_position,
            progress: job.progress.clone(),
            tab: job.tab.clone(),
            error: job.error.clone(),
            has_midi: job.has_midi,
        })
    }

    /// Path of the MIDI file of a finished job, if it has one.
    pub fn midi_path(&self, id: &str) -> Option<PathBuf> {
        let inner = self.lock();
        let job = inner.jobs.get(id)?;
        (job.status == Status::Done && job.has_midi).then(|| job.dir.join("bassline.mid"))
    }

    fn set_progress(&self, id: &str, line: &str) {
        if let Some(job) = self.lock().jobs.get_mut(id) {
            job.progress = line.chars().take(MAX_PROGRESS_CHARS).collect();
        }
    }

    /// Takes the next waiting job and marks it as running.
    fn start_next(&self) -> Option<(String, JobOptions, PathBuf, PathBuf)> {
        let mut inner = self.lock();
        let id = inner.queue.pop_front()?;
        let job = inner.jobs.get_mut(&id)?;
        job.status = Status::Running;
        job.progress = "Starting".to_string();
        Some((id, job.options.clone(), job.dir.clone(), job.input.clone()))
    }

    fn finish(&self, id: &str, result: Result<RunOutput>) {
        let mut inner = self.lock();
        let Some(job) = inner.jobs.get_mut(id) else {
            return;
        };
        match result {
            Ok(output) => {
                job.status = Status::Done;
                job.tab = Some(output.tab);
                job.has_midi = output.has_midi;
            }
            Err(error) => {
                job.status = Status::Failed;
                job.error = Some(format!("{error:#}"));
            }
        }
        job.progress.clear();
        job.finished_at = Some(Instant::now());
    }

    /// Runs queued jobs forever, one at a time.
    pub async fn run_worker(self: Arc<Self>) {
        loop {
            let Some((id, options, dir, input)) = self.start_next() else {
                self.wake.notified().await;
                continue;
            };
            info!("Job {id} started");
            let started = Instant::now();
            let result = self.run_cli(&id, &options, &dir, &input).await;
            match &result {
                Ok(_) => info!("Job {id} done in {:.0} s", started.elapsed().as_secs_f64()),
                Err(error) => warn!("Job {id} failed: {error:#}"),
            }
            // The audio and the stems are large and no longer needed.
            let _ = tokio::fs::remove_file(&input).await;
            let _ = tokio::fs::remove_dir_all(dir.join("stems")).await;
            self.finish(&id, result);
        }
    }

    /// Forgets finished jobs after their time-to-live and deletes their files.
    pub async fn run_sweeper(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            for dir in self.take_expired() {
                let _ = tokio::fs::remove_dir_all(dir).await;
            }
        }
    }

    fn take_expired(&self) -> Vec<PathBuf> {
        let mut inner = self.lock();
        let ttl = self.config.result_ttl;
        let expired: Vec<String> = inner
            .jobs
            .iter()
            .filter(|(_, job)| job.finished_at.is_some_and(|finished| finished.elapsed() > ttl))
            .map(|(id, _)| id.clone())
            .collect();
        expired.iter().filter_map(|id| inner.jobs.remove(id)).map(|job| job.dir).collect()
    }

    async fn run_cli(self: &Arc<Self>, id: &str, options: &JobOptions, dir: &Path, input: &Path) -> Result<RunOutput> {
        let tab_path = dir.join("tab.txt");
        let midi_path = dir.join("bassline.mid");

        let mut command = Command::new(&self.config.cli);
        command
            .arg(input)
            .arg(format!("--tuning={}", options.tuning))
            .arg(format!("--frets={}", options.frets))
            .arg("--output")
            .arg(&tab_path)
            .arg("--midi")
            .arg(&midi_path)
            .arg("--work-dir")
            .arg(dir.join("stems"));
        if let Some(bpm) = options.bpm {
            command.arg(format!("--bpm={bpm}"));
        }
        if !options.separate {
            command.arg("--no-separate");
        }
        // Own process group, so a timeout can also kill Demucs, which the CLI spawns.
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true).process_group(0);

        let mut child = command.spawn().with_context(|| format!("cannot start {}", self.config.cli.display()))?;
        let pid = child.id();
        let stderr = child.stderr.take().context("the transcriber's output was not captured")?;
        let follower = tokio::spawn(follow_progress(Arc::clone(self), id.to_string(), stderr));

        let status = match tokio::time::timeout(self.config.job_timeout, child.wait()).await {
            Ok(status) => status.context("cannot wait for the transcriber")?,
            Err(_) => {
                if let Some(pid) = pid {
                    kill_process_group(pid);
                }
                let _ = child.wait().await;
                follower.abort();
                bail!("the job took longer than {} minutes and was cancelled", self.config.job_timeout.as_secs() / 60);
            }
        };
        let tail = follower.await.unwrap_or_default();
        if !status.success() {
            bail!("{}", error_summary(&tail));
        }
        let tab = tokio::fs::read_to_string(&tab_path).await.context("the transcriber produced no tab")?;
        Ok(RunOutput { tab, has_midi: midi_path.is_file() })
    }
}

fn kill_process_group(pid: u32) {
    // SAFETY: kill(2) with a negative pid signals the process group; it touches no memory.
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

/// Reads the child's stderr, publishing the latest line as the job progress.
/// Lines end at `\n` or `\r`, because Demucs redraws its progress bar with `\r`.
/// Returns the last few lines, for error reporting.
async fn follow_progress(jobs: Arc<Jobs>, id: String, mut stderr: ChildStderr) -> String {
    let mut tail: VecDeque<String> = VecDeque::with_capacity(TAIL_LINES);
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for &byte in &chunk[..read] {
            if byte != b'\n' && byte != b'\r' {
                pending.push(byte);
            } else if let Some(line) = take_line(&mut pending) {
                publish_line(&jobs, &id, &mut tail, line);
            }
        }
    }
    if let Some(line) = take_line(&mut pending) {
        publish_line(&jobs, &id, &mut tail, line);
    }
    tail.into_iter().collect::<Vec<_>>().join("\n")
}

fn publish_line(jobs: &Jobs, id: &str, tail: &mut VecDeque<String>, line: String) {
    jobs.set_progress(id, &line);
    if tail.len() == TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(line);
}

fn take_line(buffer: &mut Vec<u8>) -> Option<String> {
    let line = String::from_utf8_lossy(buffer).trim().to_string();
    buffer.clear();
    (!line.is_empty()).then_some(line)
}

/// Picks the message of the last `ERROR` log line, or else the last line printed.
fn error_summary(tail: &str) -> String {
    let message = tail
        .lines()
        .rev()
        .find(|line| line.contains("ERROR"))
        .map(|line| line.split_once("] ").map_or(line, |(_, message)| message))
        .or_else(|| tail.lines().last())
        .unwrap_or("the transcriber failed without a message");
    message.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_jobs(max_queue: usize) -> Arc<Jobs> {
        Jobs::new(Config {
            work_dir: PathBuf::from("/nonexistent"),
            cli: PathBuf::from("bassline-to-tab"),
            max_queue,
            job_timeout: Duration::from_secs(60),
            result_ttl: Duration::from_secs(0),
        })
    }

    fn enqueue(jobs: &Jobs, id: &str) -> Result<(), QueueFull> {
        jobs.enqueue(id.to_string(), JobOptions::default(), PathBuf::from("input.wav"))
    }

    #[test]
    fn take_line_trims_and_skips_blank_lines() {
        let mut buffer = b"  hello \n".to_vec();
        assert_eq!(take_line(&mut buffer).as_deref(), Some("hello"));
        assert!(buffer.is_empty());
        let mut blank = b"   ".to_vec();
        assert_eq!(take_line(&mut blank), None);
    }

    #[test]
    fn error_summary_prefers_the_logged_error() {
        let tail = "Demucs noise\n[ERROR bassline_to_tab] no notes were detected\n";
        assert_eq!(error_summary(tail), "no notes were detected");
    }

    #[test]
    fn error_summary_falls_back_to_the_last_line() {
        assert_eq!(error_summary("first\nsecond"), "second");
        assert_eq!(error_summary(""), "the transcriber failed without a message");
    }

    #[test]
    fn queue_rejects_jobs_beyond_its_capacity() {
        let jobs = test_jobs(2);
        assert!(jobs.has_room());
        assert!(enqueue(&jobs, "a").is_ok());
        assert!(enqueue(&jobs, "b").is_ok());
        assert!(!jobs.has_room());
        assert!(enqueue(&jobs, "c").is_err());
    }

    #[test]
    fn queued_jobs_report_their_position() {
        let jobs = test_jobs(4);
        enqueue(&jobs, "a").unwrap();
        enqueue(&jobs, "b").unwrap();
        assert_eq!(jobs.view("a").unwrap().queue_position, Some(1));
        assert_eq!(jobs.view("b").unwrap().queue_position, Some(2));
        assert!(jobs.view("missing").is_none());
    }

    #[test]
    fn running_and_finished_jobs_have_no_queue_position() {
        let jobs = test_jobs(4);
        enqueue(&jobs, "a").unwrap();
        let (id, ..) = jobs.start_next().unwrap();
        assert_eq!(id, "a");
        let running = jobs.view("a").unwrap();
        assert_eq!(running.status, Status::Running);
        assert_eq!(running.queue_position, None);

        jobs.finish("a", Ok(RunOutput { tab: "G|--0--|".to_string(), has_midi: false }));
        let done = jobs.view("a").unwrap();
        assert_eq!(done.status, Status::Done);
        assert_eq!(done.tab.as_deref(), Some("G|--0--|"));
        assert!(jobs.midi_path("a").is_none());
    }

    #[test]
    fn failed_jobs_keep_their_error() {
        let jobs = test_jobs(4);
        enqueue(&jobs, "a").unwrap();
        jobs.start_next().unwrap();
        jobs.finish("a", Err(anyhow::anyhow!("boom")));
        let failed = jobs.view("a").unwrap();
        assert_eq!(failed.status, Status::Failed);
        assert_eq!(failed.error.as_deref(), Some("boom"));
    }

    #[test]
    fn expired_jobs_are_forgotten() {
        let jobs = test_jobs(4);
        enqueue(&jobs, "a").unwrap();
        jobs.start_next().unwrap();
        // Still running: never expires.
        assert!(jobs.take_expired().is_empty());
        jobs.finish("a", Ok(RunOutput { tab: String::new(), has_midi: false }));
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(jobs.take_expired(), vec![PathBuf::from("/nonexistent/a")]);
        assert!(jobs.view("a").is_none());
    }
}
