# Changelog

## 2.2.0 - Image mode and more boards

### Added

- `Video / IMG` switcher for browsing either videos or images from the same board list.
- Image modal viewer with download/copy/navigation support.
- Image filtering for `jpg`, `jpeg`, `png`, `gif`, and `webp`.
- New supported sites: Uboachan, Smuglo, Arisuchan, and Endchan.
- Endchan-specific catalog/thread fetcher.

### Improved

- Batch download now follows the selected media mode and can save either videos or images.
- Project metadata now describes media support instead of video-only browsing.

### Fixed

- Broken or missing board thumbnails now fall back to alternate thumbs, original images, or the first video frame.

## 2.1.0 - Batch download and stability fixes

### Added

- Electron-only `Download all` button for the current board.
- Native folder picker before batch download starts.
- Background download queue that saves videos into a timestamped folder.
- In-app download progress panel with percent, file count, downloaded size, cancel, and hide controls.
- Safe preload bridge for Electron IPC.

### Fixed

- Infinite scroll no longer stops after the first rendered batch.
- Download progress panel can now be hidden or dismissed correctly.
- Download cancel now removes the progress panel immediately.
- Board media rendering remains capped at 1500 videos for better stability.

### Improved

- Larger render chunks for smoother scrolling through big boards.
- More reliable scroll fallback in addition to `IntersectionObserver`.
- Minor Electron download handling and filename safety improvements.
