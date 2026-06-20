# USB-Reddit - 포터블 레딧 클론

USB 드라이브나 휴대용 저장장치에서 바로 실행되는 포터블 Reddit 클론 애플리케이션입니다. macOS와 Windows에서 추가 설정 없이 즉시 실행 가능합니다.

## 주요 기능

- **완전 포터블**: 시스템에 Node.js를 설치할 필요 없이 `bin/` 폴더의 내장 바이너리를 사용
- **간편 실행**: Windows에서 `start.bat` 또는 macOS에서 `start_mac.command`를 실행
- **로컬 데이터베이스**: SQLite를 사용하여 모든 게시물과 데이터를 `data/` 폴더에 안전하게 저장
- **오프라인 지원**: 초기 설정 후 인터넷 연결 없이 실행 가능

## 실행 방법

### Windows
1. 폴더를 원하는 위치(예: USB 드라이브)에 복사합니다.
2. `start.bat`을 실행합니다.
3. 브라우저에서 `http://localhost:3000`에 접속합니다.

### macOS
1. 폴더를 원하는 위치에 복사합니다.
2. `start_mac.command`를 더블클릭합니다.
3. 브라우저에서 `http://localhost:3000`에 접속합니다.

## 기술 스택

- **Backend**: Node.js, Express
- **데이터베이스**: SQLite
- **Frontend**: HTML, CSS, JavaScript
- **PWA**: 오프라인 캐싱 지원

## 프로젝트 구조

```
USB-Reddit/
├── public/           # 프론트엔드 HTML, CSS, JS 파일
├── server/           # Node.js 서버 로직 및 의존성 확인 스크립트
├── bin/              # 포터블 Node.js 바이너리
├── data/             # SQLite 데이터베이스 (최초 실행 시 생성)
├── exports/          # Markdown 내보내기 파일 저장소
├── start.bat         # Windows 실행 스크립트
├── start_mac.command # macOS 실행 스크립트
└── README.md         # 프로젝트 문서
```

## 참고사항

- `data/` 폴더를 삭제하면 모든 게시물 데이터가 초기화됩니다.

## 라이선스

MIT License
