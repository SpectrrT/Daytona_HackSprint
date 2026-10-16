#!/usr/bin/env python3
"""Record the real X11 terminal without baking in its cursor; sample actual X11
pointer position/buttons separately for Recordly's cursor rendering pipeline.
"""
import argparse
import ctypes
import ctypes.util
import json
import signal
import subprocess
import threading
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--size", default="1600x1000")
    args = parser.parse_args()
    width, height = map(int, args.size.split("x"))
    output = Path(args.output)
    x11 = ctypes.CDLL(ctypes.util.find_library("X11"))
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
    display = x11.XOpenDisplay(b":0")
    if not display:
        raise RuntimeError("Native X11 desktop is not running")
    root = x11.XDefaultRootWindow(display)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    log = output.with_suffix(".capture.log").open("w")
    started = time.time()
    process = subprocess.Popen(["ffmpeg", "-hide_banner", "-y", "-f", "x11grab", "-framerate", "30", "-video_size", args.size, "-draw_mouse", "0", "-i", ":0.0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)], stdin=subprocess.PIPE, stdout=log, stderr=log)
    output.with_suffix(".capture.pid").write_text(str(__import__("os").getpid()))
    output.with_suffix(".capture.json").write_text(json.dumps({"startedAt": started, "cursorBakedIn": False, "capture": "actual Daytona X11 framebuffer", "width": width, "height": height}))
    samples = []
    previous_buttons = 0
    try:
        while not stopped.is_set() and process.poll() is None:
            root_return, child_return = ctypes.c_ulong(), ctypes.c_ulong()
            rx, ry, wx, wy, mask = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint()
            x11.XQueryPointer(display, root, ctypes.byref(root_return), ctypes.byref(child_return), ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
            buttons = mask.value & (256 | 512 | 1024)
            interaction = "click" if buttons and not previous_buttons else "mouseup" if previous_buttons and not buttons else "move"
            samples.append({"timeMs": (time.time() - started) * 1000, "cx": max(0, min(1, rx.value / width)), "cy": max(0, min(1, ry.value / height)), "cursorType": "arrow", "interactionType": interaction})
            previous_buttons = buttons
            stopped.wait(1 / 30)
    finally:
        if process.poll() is None:
            process.communicate(b"q\n", timeout=30)
        output.with_name(output.name + ".cursor.json").write_text(json.dumps({"version": 1, "samples": samples}))
        if process.returncode:
            raise RuntimeError("Native framebuffer recording failed")


if __name__ == "__main__":
    main()
