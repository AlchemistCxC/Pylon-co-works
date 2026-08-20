use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn temp(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "pylon-process-{label}-{}-{stamp}",
        std::process::id()
    ))
}

fn service_script() -> &'static str {
    r#"import json, os, subprocess, sys, threading, time
lock = threading.Lock()
cancelled = set()
stubborn = False

def send(value):
    with lock:
        sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
        sys.stdout.flush()

def delayed(request_id, delay):
    time.sleep(delay)
    if str(request_id) not in cancelled:
        send({'jsonrpc':'2.0','id':request_id,'result':'late'})

for raw in sys.stdin:
    message = json.loads(raw)
    method = message.get('method')
    if method == '$/cancelRequest':
        cancelled.add(str(message.get('params', {}).get('id')))
        continue
    if method == 'shutdown':
        if stubborn:
            time.sleep(60)
        break
    request_id = message.get('id')
    params = message.get('params')
    if method == 'echo':
        send({'jsonrpc':'2.0','id':request_id,'result':params})
    elif method == 'slow':
        threading.Thread(target=delayed, args=(request_id, 10), daemon=True).start()
    elif method == 'armStubborn':
        stubborn = True
        send({'jsonrpc':'2.0','id':request_id,'result':'armed'})
    elif method == 'crash':
        os._exit(7)
    elif method == 'flood':
        for index in range(2048):
            sys.stderr.write(('err-%04d-' % index) + ('x' * 512) + '\n')
            send({'jsonrpc':'2.0','method':'progress','params':{'index':index}})
        sys.stderr.flush()
        send({'jsonrpc':'2.0','id':request_id,'result':'drained'})
    elif method == 'spawnChild':
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        path = params['pidFile']
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(str(child.pid))
        send({'jsonrpc':'2.0','id':request_id,'result':child.pid})
    else:
        send({'jsonrpc':'2.0','id':request_id,'error':{'code':-32601,'message':'missing'}})
"#
}

fn fixture(base: &Path) -> crate::paths::DataDirs {
    let config = base.join("config");
    let data = base.join("data");
    let store = config.join("pylon/plugins");
    let package_id = "p.process@1.0.0-test";
    let package = store.join("packages/p.process").join(package_id);
    fs::create_dir_all(package.join("dist")).unwrap();
    fs::create_dir_all(package.join("bin")).unwrap();
    fs::create_dir_all(&data).unwrap();
    fs::write(package.join("dist/entry.js"), b"export default {};").unwrap();
    fs::write(package.join("bin/service.py"), service_script()).unwrap();

    #[cfg(windows)]
    let (platform, executable) = {
        let command = format!(
            "@{} -u \"%~dp0service.py\" %*\r\n",
            crate::test_utils::test_python_exe()
        );
        fs::write(package.join("bin/service.cmd"), command).unwrap();
        ("windows-x86_64", "./bin/service.cmd")
    };
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let (platform, executable) = {
        use std::os::unix::fs::PermissionsExt;
        let path = package.join("bin/service");
        fs::write(
            &path,
            format!(
                "#!/bin/sh\nexec {} -u \"$(dirname \"$0\")/service.py\" \"$@\"\n",
                crate::test_utils::test_python_exe()
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        ("linux-x86_64", "./bin/service")
    };
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let (platform, executable) = {
        use std::os::unix::fs::PermissionsExt;
        let path = package.join("bin/service");
        fs::write(
            &path,
            format!(
                "#!/bin/sh\nexec {} -u \"$(dirname \"$0\")/service.py\" \"$@\"\n",
                crate::test_utils::test_python_exe()
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        ("macos-aarch64", "./bin/service")
    };
    fs::write(
        package.join("pylon-plugin.json"),
        serde_json::to_vec_pretty(&json!({
            "id": "p.process",
            "version": "1.0.0",
            "entry": "./dist/entry.js",
            "executables": { "service": { platform: executable } }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::create_dir_all(store.join("data")).unwrap();
    fs::create_dir_all(store.join("runtime")).unwrap();
    fs::create_dir_all(store.join("transactions")).unwrap();
    fs::write(
        store.join("state.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 2,
            "activeVersions": { "p.process": package_id },
            "packageHistory": { "p.process": [package_id] },
            "legacyMigrationComplete": true
        }))
        .unwrap(),
    )
    .unwrap();
    crate::paths::DataDirs {
        data_root: data,
        config_root: config,
        mode: crate::paths::StorageMode::AppData,
        portable_requested: false,
        fallback_reason: None,
    }
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

fn app_for(base: &Path) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_data_dirs(fixture(base))
        .build();
    app.manage(state);
    app
}

fn spawn_service(app: &tauri::AppHandle<tauri::test::MockRuntime>) -> PluginProcessDescriptor {
    app.state::<crate::AppState>()
        .plugin_processes
        .spawn(
            app.clone(),
            "p.process".into(),
            "p.process@1.0.0-test#run-1".into(),
            None,
            "service".into(),
            PluginProcessOptions::default(),
        )
        .unwrap()
}

#[tokio::test]
async fn json_rpc_and_concurrent_stream_draining() {
    let base = temp("rpc");
    let app = app_for(&base);
    let descriptor = spawn_service(app.handle());
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    let echoed = supervisor
        .request(
            &descriptor.process_id,
            "echo".into(),
            Some(json!({ "answer": 42 })),
            2_000,
            Some("echo-1".into()),
        )
        .await
        .unwrap();
    assert_eq!(echoed, json!({ "answer": 42 }));
    let flood = supervisor
        .request(
            &descriptor.process_id,
            "flood".into(),
            None,
            10_000,
            Some("flood-1".into()),
        )
        .await
        .unwrap();
    assert_eq!(flood, "drained");
    let stderr = supervisor
        .logs(&descriptor.process_id, Some("stderr"), 12)
        .unwrap();
    assert_eq!(stderr.len(), 12);
    assert!(stderr.iter().all(|entry| entry.kind == "stderr"));
    assert!(stderr
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    supervisor
        .terminate(app.handle().clone(), &descriptor.process_id)
        .await
        .unwrap();
    fs::remove_dir_all(base).ok();
}

#[tokio::test]
async fn candidate_process_uses_staged_package_before_active_pointer_switch() {
    let base = temp("candidate-package");
    let app = app_for(&base);
    let store = base.join("config/pylon/plugins");
    let old_package = store.join("packages/p.process/p.process@1.0.0-test");
    let candidate_id = "p.process@2.0.0-candidate";
    copy_tree(
        &old_package,
        &store.join("packages/p.process").join(candidate_id),
    );

    let descriptor = app
        .state::<crate::AppState>()
        .plugin_processes
        .spawn(
            app.handle().clone(),
            "p.process".into(),
            format!("{candidate_id}#run-candidate"),
            Some(candidate_id.into()),
            "service".into(),
            PluginProcessOptions::default(),
        )
        .unwrap();
    let state: Value =
        serde_json::from_slice(&fs::read(store.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["activeVersions"]["p.process"], "p.process@1.0.0-test");
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    assert_eq!(
        supervisor
            .request(
                &descriptor.process_id,
                "echo".into(),
                Some(json!({ "candidate": true })),
                2_000,
                Some("candidate-ready".into()),
            )
            .await
            .unwrap(),
        json!({ "candidate": true })
    );
    supervisor
        .terminate(app.handle().clone(), &descriptor.process_id)
        .await
        .unwrap();
    fs::remove_dir_all(base).ok();
}

#[tokio::test]
async fn cancellation_settles_pending_request() {
    let base = temp("cancel");
    let app = app_for(&base);
    let descriptor = spawn_service(app.handle());
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    let request_supervisor = supervisor.clone();
    let process_id = descriptor.process_id.clone();
    let pending = tokio::spawn(async move {
        request_supervisor
            .request(
                &process_id,
                "slow".into(),
                None,
                20_000,
                Some("cancel-me".into()),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    supervisor
        .cancel(&descriptor.process_id, "cancel-me")
        .unwrap();
    assert!(pending.await.unwrap().unwrap_err().contains("cancelled"));
    supervisor
        .kill(app.handle(), &descriptor.process_id)
        .unwrap();
    fs::remove_dir_all(base).ok();
}

#[tokio::test]
async fn graceful_shutdown_then_timeout_kill_are_idempotent() {
    let base = temp("shutdown");
    let app = app_for(&base);
    let descriptor = spawn_service(app.handle());
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    supervisor
        .terminate(app.handle().clone(), &descriptor.process_id)
        .await
        .unwrap();
    supervisor
        .terminate(app.handle().clone(), &descriptor.process_id)
        .await
        .unwrap();
    let status = supervisor
        .get(&descriptor.process_id)
        .unwrap()
        .descriptor()
        .status;
    assert_eq!(status, ProcessStatus::Exited);
    fs::remove_dir_all(base).ok();
}

#[tokio::test]
async fn shutdown_timeout_escalates_to_tree_kill() {
    let base = temp("timeout-kill");
    let app = app_for(&base);
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    let mut options = PluginProcessOptions::default();
    options.shutdown = ShutdownOptions {
        method: ShutdownMethod::JsonRpc,
        timeout_ms: 100,
    };
    let descriptor = supervisor
        .spawn(
            app.handle().clone(),
            "p.process".into(),
            "p.process@1.0.0-test#run-timeout".into(),
            None,
            "service".into(),
            options,
        )
        .unwrap();
    supervisor
        .request(
            &descriptor.process_id,
            "armStubborn".into(),
            None,
            2_000,
            Some("arm".into()),
        )
        .await
        .unwrap();
    supervisor
        .terminate(app.handle().clone(), &descriptor.process_id)
        .await
        .unwrap();
    assert_eq!(
        supervisor
            .get(&descriptor.process_id)
            .unwrap()
            .descriptor()
            .status,
        ProcessStatus::Exited
    );
    fs::remove_dir_all(base).ok();
}

#[tokio::test]
async fn on_failure_restart_replaces_generation_and_recovers_rpc() {
    let base = temp("restart");
    let app = app_for(&base);
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    let mut options = PluginProcessOptions::default();
    options.restart = RestartOptions {
        policy: RestartPolicy::OnFailure,
        max_attempts: 1,
        backoff_ms: 20,
    };
    let descriptor = supervisor
        .spawn(
            app.handle().clone(),
            "p.process".into(),
            "p.process@1.0.0-test#run-restart".into(),
            None,
            "service".into(),
            options,
        )
        .unwrap();
    let error = supervisor
        .request(
            &descriptor.process_id,
            "crash".into(),
            None,
            3_000,
            Some("crash".into()),
        )
        .await
        .unwrap_err();
    assert!(error.contains("restarting"));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let current = supervisor.get(&descriptor.process_id).unwrap().descriptor();
            if current.status == ProcessStatus::Running && current.restart_attempts == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let recovered = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match supervisor
                .request(
                    &descriptor.process_id,
                    "echo".into(),
                    Some(json!("recovered")),
                    2_000,
                    Some("after-restart".into()),
                )
                .await
            {
                Ok(value) => break value,
                Err(_) => tokio::time::sleep(Duration::from_millis(40)).await,
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(recovered, "recovered");
    supervisor
        .kill(app.handle(), &descriptor.process_id)
        .unwrap();
    fs::remove_dir_all(base).ok();
}

#[cfg(windows)]
#[tokio::test]
async fn job_object_kills_descendant_process_tree() {
    let base = temp("tree");
    let app = app_for(&base);
    let descriptor = spawn_service(app.handle());
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    let pid_file = base.join("child.pid");
    let child_pid = supervisor
        .request(
            &descriptor.process_id,
            "spawnChild".into(),
            Some(json!({ "pidFile": pid_file.to_string_lossy() })),
            3_000,
            Some("spawn-child".into()),
        )
        .await
        .unwrap()
        .as_u64()
        .unwrap() as u32;
    supervisor
        .kill(app.handle(), &descriptor.process_id)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {child_pid}"), "/FO", "CSV", "/NH"])
        .output()
        .unwrap();
    let listing = String::from_utf8_lossy(&output.stdout);
    assert!(
        !listing.contains(&format!("\"{child_pid}\"")),
        "descendant still running: {listing}"
    );
    fs::remove_dir_all(base).ok();
}

#[cfg(windows)]
#[tokio::test]
async fn checked_in_json_rpc_example_is_runnable() {
    let base = temp("checked-in-example");
    let dirs = fixture(&base);
    let store = crate::paths::plugin_root(&dirs);
    let package_id = "process.json-rpc-echo@1.0.0-example";
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../examples/process-plugins/process.json-rpc-echo");
    let target = store
        .join("packages/process.json-rpc-echo")
        .join(package_id);
    copy_tree(&source, &target);
    fs::write(
        store.join("state.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 2,
            "activeVersions": { "process.json-rpc-echo": package_id },
            "packageHistory": { "process.json-rpc-echo": [package_id] },
            "legacyMigrationComplete": true
        }))
        .unwrap(),
    )
    .unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(
        crate::test_utils::TestStateBuilder::bare()
            .with_data_dirs(dirs)
            .build(),
    );
    let supervisor = app.state::<crate::AppState>().plugin_processes.clone();
    let descriptor = supervisor
        .spawn(
            app.handle().clone(),
            "process.json-rpc-echo".into(),
            "process.json-rpc-echo@1.0.0-example#run-1".into(),
            None,
            "echo".into(),
            PluginProcessOptions::default(),
        )
        .unwrap();
    assert_eq!(
        supervisor
            .request(
                &descriptor.process_id,
                "echo".into(),
                Some(json!({ "ready": true })),
                3_000,
                Some("readiness".into()),
            )
            .await
            .unwrap(),
        json!({ "ready": true })
    );
    supervisor
        .terminate(app.handle().clone(), &descriptor.process_id)
        .await
        .unwrap();
    fs::remove_dir_all(base).ok();
}
