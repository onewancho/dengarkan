# DENGARKAN — Legal & Compliance Notice

## 1. Product Nature & Architecture

Dengarkan is an audio-only personal web player designed for low-power, lightweight playback of public YouTube content on mobile browsers (particularly Safari on iOS).

Key architectural boundaries:
- **No Binary Storage**: Dengarkan does NOT host, download, archive, redistribute, or store audio or video binary files on its servers or database.
- **Direct Stream Delivery**: Audio streams are played directly from YouTube CDN endpoints (`*.googlevideo.com`) by the client's native browser engine (`HTMLAudioElement`).
- **No DRM Circumvention**: Dengarkan does NOT circumvent, decrypt, or bypass any Digital Rights Management (DRM) technologies such as Google Widevine or Apple FairPlay. Any video requiring DRM, premium subscription authorization, or private access cannot be played and is rejected by the audio resolver with an explicit `VIDEO_UNAVAILABLE` error.
- **No Live Stream Manipulation**: Live streams are filtered and blocked (`NO_AUDIO_STREAM`) to adhere to standard content boundaries.

## 2. Intellectual Property & Fair Use

- All video titles, channel names, thumbnails, and audio streams remain the intellectual property of their respective creators and copyright holders, hosted by YouTube (Google LLC).
- Dengarkan does not claim any ownership, affiliation, sponsorship, or endorsement by YouTube or Google LLC.
- The software is intended solely for personal, non-commercial research, accessibility, and low-resource media consumption.

## 3. Tooling & Dependencies

- Dengarkan utilizes `yt-dlp`, an open-source command-line tool released under the Unlicense, strictly as a metadata and direct stream URL resolver for publicly accessible videos.
- Users and administrators deploying Dengarkan are responsible for adhering to the terms of service of any third-party platforms accessed, as well as applicable local laws and regulations regarding media consumption.
