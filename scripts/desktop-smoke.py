"""Verify the actual frozen backend, including the packaged CARLA Python client."""
from __future__ import annotations
import argparse, ctypes, hashlib, http.client, json, os, queue, secrets, subprocess, tempfile, threading, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def windows_job(process):
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_=[("PerProcessUserTimeLimit",ctypes.c_int64),("PerJobUserTimeLimit",ctypes.c_int64),("LimitFlags",w.DWORD),("MinimumWorkingSetSize",ctypes.c_size_t),("MaximumWorkingSetSize",ctypes.c_size_t),("ActiveProcessLimit",w.DWORD),("Affinity",ctypes.c_size_t),("PriorityClass",w.DWORD),("SchedulingClass",w.DWORD)]
    class IO(ctypes.Structure):
        _fields_=[(name,ctypes.c_uint64) for name in ("ReadOperationCount","WriteOperationCount","OtherOperationCount","ReadTransferCount","WriteTransferCount","OtherTransferCount")]
    class Limits(ctypes.Structure):
        _fields_=[("BasicLimitInformation",Basic),("IoInfo",IO),("ProcessMemoryLimit",ctypes.c_size_t),("JobMemoryLimit",ctypes.c_size_t),("PeakProcessMemoryUsed",ctypes.c_size_t),("PeakJobMemoryUsed",ctypes.c_size_t)]
    kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    kernel.CreateJobObjectW.restype=w.HANDLE
    kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,w.LPCWSTR]
    kernel.SetInformationJobObject.argtypes=[w.HANDLE,ctypes.c_int,ctypes.c_void_p,w.DWORD]
    kernel.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE]
    kernel.CloseHandle.argtypes=[w.HANDLE]
    job=kernel.CreateJobObjectW(None,None)
    if not job: raise ctypes.WinError(ctypes.get_last_error())
    limits=Limits();limits.BasicLimitInformation.LimitFlags=0x2000
    if not kernel.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job,process._handle):
        error=ctypes.get_last_error();kernel.CloseHandle(job);raise ctypes.WinError(error)
    class ThreadEntry(ctypes.Structure):
        _fields_=[("dwSize",w.DWORD),("cntUsage",w.DWORD),("th32ThreadID",w.DWORD),("th32OwnerProcessID",w.DWORD),("tpBasePri",w.LONG),("tpDeltaPri",w.LONG),("dwFlags",w.DWORD)]
    kernel.CreateToolhelp32Snapshot.argtypes=[w.DWORD,w.DWORD];kernel.CreateToolhelp32Snapshot.restype=w.HANDLE
    kernel.Thread32First.argtypes=[w.HANDLE,ctypes.POINTER(ThreadEntry)];kernel.Thread32Next.argtypes=kernel.Thread32First.argtypes
    kernel.OpenThread.argtypes=[w.DWORD,w.BOOL,w.DWORD];kernel.OpenThread.restype=w.HANDLE
    kernel.ResumeThread.argtypes=[w.HANDLE];kernel.ResumeThread.restype=w.DWORD
    snapshot=kernel.CreateToolhelp32Snapshot(4,0);entry=ThreadEntry();entry.dwSize=ctypes.sizeof(entry)
    exists=kernel.Thread32First(snapshot,ctypes.byref(entry));resumed=False
    while exists:
        if entry.th32OwnerProcessID == process.pid:
            thread=kernel.OpenThread(2,False,entry.th32ThreadID)
            if thread:
                resumed=kernel.ResumeThread(thread) != 0xffffffff;kernel.CloseHandle(thread)
            break
        exists=kernel.Thread32Next(snapshot,ctypes.byref(entry))
    kernel.CloseHandle(snapshot)
    if not resumed:
        kernel.CloseHandle(job);raise RuntimeError("Could not resume owned backend process")
    return lambda: kernel.CloseHandle(job)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True, type=Path)
    args = parser.parse_args()
    executable = args.backend.resolve()
    token = secrets.token_hex(32)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="ghostwheel-package-test-") as temporary:
        log = (Path(temporary) / "stderr.log").open("wb")
        process = subprocess.Popen([str(executable), "--port", "0", "--db", str(Path(temporary)/"test.sqlite3"), "--token", token, "--desktop"], stdout=subprocess.PIPE, stderr=log, stdin=subprocess.DEVNULL, creationflags=0x08000004 if os.name == "nt" else 0)
        close_job = windows_job(process) if os.name == "nt" else lambda: process.terminate()
        receipt = None
        try:
            pending = queue.Queue()
            threading.Thread(target=lambda: pending.put(process.stdout.readline(4096)), daemon=True).start()
            ready = json.loads(pending.get(timeout=45))
            assert ready["status"] == "ready" and ready["simulation_only"] is True and 0 < ready["port"] < 65536, ready
            def request(path, body=None, authenticated=True):
                connection = http.client.HTTPConnection("127.0.0.1", ready["port"], timeout=120)
                headers={"Content-Type":"application/json"}
                if authenticated: headers["X-Ghostwheel-Token"] = token
                connection.request("GET" if body is None else "POST", path, None if body is None else json.dumps(body), headers)
                response=connection.getresponse(); result=json.loads(response.read()); status=response.status
                connection.close()
                return status,result
            assert request("/api/health",authenticated=False)[1]["simulation_only"] is True
            assert request("/api/bootstrap",authenticated=False)[0] == 403
            assert request("/api/state",authenticated=False)[0] == 403
            assert request("/api/control",{},authenticated=False)[0] == 403
            status,bootstrap=request("/api/bootstrap")
            assert status == 200 and bootstrap["token"] == token and len(bootstrap["architectures"]) >= 3
            status,invalid=request("/api/control",{})
            assert status == 200 and invalid["accepted"] is False
            status,client=request("/api/carla/status")
            assert status == 200 and client["available"] is True and client["connected"] is False, client
            status,experiments=request("/api/experiments",{"seed":42})
            assert status == 200 and experiments["totals"]["failed"] == 0 and experiments["totals"]["assertions"] >= 60,experiments
            receipt={"status":"passed","artifact":executable.name,"sha256":hashlib.sha256(executable.read_bytes()).hexdigest(),"checks":["private readiness on OS-assigned loopback port","health reports simulation only","desktop GET bootstrap/state denied without token","POST control denied without token","authenticated bootstrap exposes three architectures","invalid control rejected","bundled CARLA client import passes without simulator server","packaged experiment suite executed"],"carla_client":client,"experiments":experiments,"elapsed_s":round(time.perf_counter()-started,3),"carla_server_exercised":False}
            output=ROOT/"output"/"verification"/"desktop-sidecar-smoke.json";output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(receipt,indent=2),encoding="utf-8")
        finally:
            close_job()
            process.wait(timeout=10)
            log.close()
        if receipt:
            receipt["owned_process_tree_stopped"] = True
            output.write_text(json.dumps(receipt,indent=2),encoding="utf-8")
            print(json.dumps({"status":"passed","receipt":str(output),"elapsed_s":receipt["elapsed_s"]},indent=2))
if __name__ == "__main__": main()
