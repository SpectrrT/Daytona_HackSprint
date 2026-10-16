# Claude terminal recording

The product runs in the installed Claude Code CLI through `pnpm claude`. The website is optional. A local terminal can be recorded directly in Recordly after macOS grants recording permission.

For a native Daytona terminal capture, these helpers transport the **actual CLI's PTY bytes** into `xfce4-terminal`, like a remote terminal. The Claude process and its sign-in remain on the controller; no Claude credentials or Daytona/Anchor provider keys are copied to the filming sandbox. The remote endpoint accepts terminal bytes and window dimensions, has a random bearer token plus a one-hour signed private preview, and cannot start a controller shell or select an executable. Claude's built-in execution tools are disabled for this recording session; the allowed MCP tools orchestrate the lab. The process host and terminal host are recorded explicitly in the manifest.

```sh
pnpm claude --doctor
pnpm terminal:record prepare
# Use the returned recording ID and private relay.json path:
python3 tools/recording/claude_pty.py --config data/terminal-recordings/ID/relay.json --directory data/terminal-recordings/ID
# In another shell:
pnpm terminal:record start ID
pnpm terminal:record type ID claude
pnpm terminal:record key ID enter
pnpm terminal:record screenshot ID
```

The native terminal now shows the real Claude interface. Complete its workspace/MCP trust flow if required, then type a hardening prompt with `type` and submit it with `key enter`. The actual Claude process calls the MCP server, which creates the live Daytona experiment and follows it through Anchor execution and independent verification. Do not substitute saved run results for a new execution.

`move`, `highlight`, and `scroll` drive the actual sandbox pointer and terminal selection/scrollback. `capture_terminal.py` records the actual X11 framebuffer with the native pointer excluded, while sampling real pointer coordinates and button transitions at 30 Hz. `finish ID` finalizes and downloads the MP4 and its matching `.cursor.json` sidecar. Recordly reads that sidecar to render a larger, smoother cursor; it does not invent cursor movements. Keep both files together when importing.

```sh
pnpm terminal:record move ID 500 350
pnpm terminal:record highlight ID 80 400 1000 400
pnpm terminal:record scroll ID up 5
pnpm terminal:record finish ID
python3 -m unittest discover -s tools/recording -p 'test_*.py' -v
```

The final Recordly project must have `autoCaptions: []`, `autoCaptionSettings.enabled: false`, and no annotation overlays. Preserve the raw capture and terminal transcript. If waiting time is cut or sped up, keep the edit manifest and remap the measured cursor timestamps with the identical cuts. Only source footage and actual terminal selections belong in the film.

Stop only the recording's own relay/capture processes and sandbox when finished. The independent agent experiment owns and cleans up its separate application/browser resources. Recordly is an optional external editing application, not a server dependency.
