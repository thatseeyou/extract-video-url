# extract-video-url

웹 페이지에서 HLS(m3u8) 동영상 URL을 추출하는 CLI 도구.

Chrome을 일반 브라우저로 실행하여 Cloudflare 등의 봇 감지를 우회하고, NetLog을 통해 네트워크 트래픽에서 m3u8 URL과 요청 헤더를 추출한다.

## 설치

```bash
npm install
```

## 사용법

```bash
node index.js <url>
```

1. Chrome 브라우저가 열리며 지정한 URL로 이동
2. 수동으로 동영상 재생
3. m3u8 URL이 감지되면 요청 헤더와 함께 콘솔에 출력
4. `sites.yaml` 규칙에 매치되면 yt-dlp 명령을 출력하고 `yt-dlp/` 폴더에 셸 스크립트로 저장
5. 브라우저를 닫으면 프로그램 종료

## sites.yaml 설정

```yaml
sites:
  - prefix: "https://hoohootv"
    targetRegEx: "https://creatorofvideo\\.com/.*/master\\.m3u8\\?t=0"
    includeCookie: true
```

| 필드 | 설명 | 기본값 |
|------|------|--------|
| `prefix` | 입력 URL이 이 문자열로 시작하면 해당 규칙 적용 | (필수) |
| `targetRegEx` | 감지된 m3u8 URL이 이 정규식에 매치될 때만 yt-dlp 명령 생성 | (필수) |
| `includeCookie` | yt-dlp 명령에 cookie 헤더 포함 여부 | `false` |

매치되는 규칙이 없으면 모든 m3u8에 대해 yt-dlp 명령을 생성한다.

## 출력 파일

yt-dlp 명령이 생성되면 `yt-dlp/` 폴더에 셸 스크립트로 저장된다.

- 파일명: `2026_03_09T21_06_16.sh` (타임스탬프 기반)
- yt-dlp 다운로드 파일명도 동일한 타임스탬프를 따름
- 실행 권한(`chmod 755`) 자동 부여

## 동작 원리

- `--log-net-log` 플래그로 Chrome의 NetLog을 캡처
- 주기적으로 NetLog 파일을 파싱하여 m3u8 요청 감지
- Playwright/CDP를 사용하지 않으므로 DevTools 감지 우회
