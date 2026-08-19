use std::env;

const BUILD_GIT_SHA_ENV: &str = "PHOENIX_BUILD_GIT_SHA";

fn main() {
    // Embed a short git SHA into the binary so the UI can surface exactly
    // which build is running. dev.py supplies the exact checkout identity;
    // release CI supplies GITHUB_SHA. An explicit environment input lets
    // Cargo reuse an unchanged build instead of relinking on every command.
    println!("cargo:rerun-if-env-changed={BUILD_GIT_SHA_ENV}");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");

    let sha = env::var(BUILD_GIT_SHA_ENV)
        .ok()
        .or_else(|| env::var("GITHUB_SHA").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let (commit, suffix) = sha
        .trim()
        .strip_suffix("-dirty")
        .map_or((sha.trim(), ""), |commit| (commit, "-dirty"));
    let identity = if commit == "unknown" {
        "unknown".to_string()
    } else if commit.len() >= 7 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        let short = commit.chars().take(12).collect::<String>();
        format!("{short}{suffix}")
    } else {
        "unknown".to_string()
    };

    println!("cargo:rustc-env=PHOENIX_GIT_SHA={identity}");
}
