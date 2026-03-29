<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="Another app icon" />
</p>

<h1 align="center">Another</h1>

A desktop app for mirroring and controlling Android devices over USB. Built with Tauri, React, and Rust.

![Another](shot.png)

Uses a bundled [scrcpy-server](https://github.com/Genymobile/scrcpy) to stream video from the device and send control inputs back.

## Features

- Real-time screen mirroring via H.264/H.265 decoding
- Touch, keyboard, scroll, and navigation input forwarding
- Configurable video quality (resolution, FPS, bitrate, codec)
- Screenshot capture
- Automatic device detection via ADB
- Light/dark/auto theme

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | Supported |
| Linux | Experimental |
| Windows | Experimental |

## Prerequisites

- An Android device connected via USB with USB debugging enabled
- [Rust](https://www.rust-lang.org/tools/install)
- [Node.js](https://nodejs.org/) and [Bun](https://bun.sh/)

## Development

```sh
bun install
bun tauri dev
```

## Build

```sh
bun tauri build
```

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Base UI
- **Backend:** Rust, Tauri 2, Tokio, openh264, turbojpeg
- **Device communication:** ADB + scrcpy-server v2.7
