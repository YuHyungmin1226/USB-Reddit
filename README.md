# USB-Reddit - 포터블 레딧 클론

USB 드라이브나 휴대용 저장장치에서 바로 실행되는 포터블 Reddit 클론 애플리케이션입니다. **Windows와 macOS**에서 추가 설정 없이 즉시 실행 가능합니다. (Linux는 지원하지 않습니다.)

## 주요 기능

- **완전 포터블**: 시스템에 Node.js를 설치할 필요 없이 `bin/` 폴더의 내장 바이너리를 사용
- **간편 실행**: Windows에서 `start.bat` 또는 macOS에서 `start_mac.command`를 실행
- **로컬 데이터베이스**: SQLite를 사용하여 모든 게시물과 데이터를 `data/` 폴더에 안전하게 저장
- **인터넷 불필요**: 내장 Node 바이너리로 인터넷 연결 없이 로컬 서버를 실행 가능

## 최초 실행 전 설정

1. `config.example.json`을 `config.json`으로 복사합니다.
2. `config.json`을 열어 관리자(admin) 비밀번호를 안전한 값으로 변경합니다.
   - `config.json`은 자격 증명을 포함하므로 git에 커밋되지 않습니다(`.gitignore` 처리).

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
- **Frontend**: HTML, CSS, JavaScript (Markdown 렌더링은 내장 `public/lib/marked.min.js` 사용)

## 프로젝트 구조

```
USB-Reddit/
├── public/                   # 프론트엔드 (HTML, CSS, JS)
│   ├── lib/                  # 내장 프론트엔드 라이브러리 (marked.min.js)
│   └── uploads/              # 사용자 업로드 파일 저장소
├── server/                   # Node.js 서버 로직
├── bin/                      # 포터블 Node.js 바이너리 (Windows/macOS)
├── data/                     # SQLite 데이터베이스 (최초 실행 시 생성)
├── exports/                  # Markdown 내보내기 파일 저장소
├── node_modules/             # 현재 OS용 의존성
├── node_modules_mac_x64/     # macOS(Intel)용 의존성
├── node_modules_mac_arm64/   # macOS(Apple Silicon)용 의존성
├── config.example.json       # 설정 템플릿 (config.json으로 복사하여 사용)
├── start.bat                 # Windows 실행 스크립트
├── start_mac.command         # macOS 실행 스크립트
└── README.md                 # 프로젝트 문서
```

## 백업 및 이식

`data/`와 `public/uploads/` 폴더는 `.gitignore`에 포함되어 git으로 추적되지 않습니다.
따라서 **git 기반으로 배포/이식할 경우 게시물 데이터와 업로드 파일이 누락됩니다.**

- 백업하거나 다른 장치로 이식할 때는 반드시 **`data/`** 폴더(데이터베이스)와 **`public/uploads/`** 폴더(업로드 파일)를 함께 복사해야 합니다.
- 폴더째 복사(USB 통째 이동)하는 경우에는 자동으로 함께 이동되므로 별도 조치가 필요 없습니다.

## 참고사항

- `data/` 폴더를 삭제하면 모든 게시물 데이터가 초기화됩니다.

## 라이선스

MIT License
