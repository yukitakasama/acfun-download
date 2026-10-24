//! 把 `app.rc`（版本信息 + 图标）编译成资源并链进 exe。
//!
//! cargo 本身不认 .rc，这里复用 Windows SDK / MSVC 的 `rc.exe`：
//! 找不到时只跳过图标与版本信息（GUI 仍可编译运行），并在 stderr 给出提示。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=app.rc");
    println!("cargo:rerun-if-changed=app.ico");
    println!("cargo:rerun-if-env-changed=RC_PATH");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let res = out_dir.join("app_link.res");
    let rc_file = PathBuf::from("app.rc");
    if !rc_file.exists() {
        println!("cargo:warning=app.rc 不存在，跳过资源编译");
        return;
    }

    let Some(rc) = find_rc() else {
        println!("cargo:warning=找不到 rc.exe（Windows SDK），本次产物没有版本信息与图标");
        return;
    };

    let mut args: Vec<String> = vec!["/nologo".into()];
    for inc in sdk_includes() {
        args.push(format!("/I{}", inc.display()));
    }
    args.push("/fo".into());
    args.push(res.display().to_string());
    args.push("app.rc".into());

    let status = Command::new(&rc).args(&args).status();
    match status {
        Ok(s) if s.success() && res.exists() => {
            println!("cargo:rustc-link-arg={}", res.display());
        }
        _ => println!("cargo:warning=rc.exe 编译资源失败，本次产物没有版本信息与图标"),
    }
}

fn find_rc() -> Option<PathBuf> {
    if let Ok(p) = env::var("RC_PATH") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(kits) = env::var("ProgramFiles(x86)") {
        roots.push(PathBuf::from(kits).join("Windows Kits/10/bin"));
    }
    roots.push(PathBuf::from("C:/Program Files (x86)/Windows Kits/10/bin"));
    for root in roots {
        if let Some(p) = newest_child(&root, "x64/rc.exe") {
            return Some(p);
        }
    }
    let msvc_roots = [
        "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC",
        "C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC",
        "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC",
    ];
    for root in msvc_roots {
        if let Some(p) = newest_child(Path::new(root), "bin/Hostx64/x64/rc.exe") {
            return Some(p);
        }
    }
    None
}

/// 目录下按版本号倒序找第一个含 `rel` 的路径。
fn newest_child(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut versions: Vec<PathBuf> = fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    versions.sort();
    versions.reverse();
    for v in versions {
        let candidate = v.join(rel);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// rc.exe 预处理器需要 SDK 头文件目录（否则 `#include <winres.h>` 找不到）。
fn sdk_includes() -> Vec<PathBuf> {
    let root = PathBuf::from("C:/Program Files (x86)/Windows Kits/10/Include");
    let Some(version) = newest_child(&root, "um") else {
        return Vec::new();
    };
    let base = version.parent().map(Path::to_path_buf).unwrap_or_default();
    ["um", "shared", "winrt"]
        .iter()
        .map(|s| base.join(s))
        .filter(|p| p.exists())
        .collect()
}
