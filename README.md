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
4. 헤더를 포함한 yt-dlp 명령도 함께 출력
5. 브라우저를 닫으면 프로그램 종료

## 동작 원리

- `--log-net-log` 플래그로 Chrome의 NetLog을 캡처
- 주기적으로 NetLog 파일을 파싱하여 m3u8 요청 감지
- Playwright/CDP를 사용하지 않으므로 DevTools 감지 우회
