// ============================================
// Vercel Serverless Function — 도서관 검색 프록시
// ============================================

const LIBRARIES = {
  spclib: {
    name: '송파어린이도서관',
    type: 'splib',
    formUrl: 'https://www.splib.or.kr/spclib/menu/10243/program/30001/plusSearchSimple.do',
    searchUrl: 'https://www.splib.or.kr/spclib/menu/10243/program/30001/plusSearchResultList.do',
    // 검색은 송파 전 도서관을 반환하므로, 결과의 도서관명으로 필터링한다.
    matchName: '송파어린이도서관',
  },
  sp2lib: {
    name: '소나무언덕2호도서관',
    type: 'splib',
    formUrl: 'https://www.splib.or.kr/sp2lib/menu/10488/program/30001/plusSearchSimple.do',
    searchUrl: 'https://www.splib.or.kr/sp2lib/menu/10488/program/30001/plusSearchResultList.do',
    matchName: '소나무언덕2호',
  },
  bdllib: {
    name: '버들초등학교 도서관',
    type: 'doksero',
    neisCode: 'B100005384',
    provCode: 'B10',
  },
};

function stripTags(html) {
  let text = html.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function parseSearchResults(html) {
  const items = [];

  // 각 검색결과 = <div class="bookArea"> ... </li> (한 도서관 소장본 1건)
  const blockRegex = /<div[^>]*class="[^"]*\bbookArea\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[1];

    // 제목: <span class="title"> 안에 하이라이트 <span class="searchKwd">가 중첩됨.
    // 따라서 닫는 </span></a> 까지 통째로 잡은 뒤 태그 제거.
    let titleRaw = '';
    let tm = block.match(/<span[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/a>/);
    if (!tm) {
      // 폴백: book_name 안의 a 태그 전체
      tm = block.match(/<[^>]*class="[^"]*book_name[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    }
    if (tm) titleRaw = stripTags(tm[1]);
    if (!titleRaw) continue;
    // "도서" 같은 분류 라벨과 앞 번호 제거 (예: "도서 1. 어린왕자" → "어린왕자")
    const title = titleRaw.replace(/^\s*(?:도서|단행본|전자책)?\s*\d+\.\s*/, '').trim();
    if (!title) continue;

    const authorMatch = block.match(/<div[^>]*class="[^"]*book_info[^"]*info01[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const info2Match = block.match(/<div[^>]*class="[^"]*book_info[^"]*info02[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const info3Match = block.match(/<div[^>]*class="[^"]*book_info[^"]*info03[^"]*"[^>]*>([\s\S]*?)<\/div>/);

    // 상태: <span class="status"><strong class="okRent|noRentLoan">대출가능/불가</strong>
    const statusMatch = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    const statusClassMatch = statusMatch ? statusMatch[0].match(/class="([^"]+)"/) : null;
    const statusText = statusMatch ? stripTags(statusMatch[1]) : '';
    const statusClass = statusClassMatch ? statusClassMatch[1] : '';
    const available = statusClass.includes('okRent') || statusText.includes('대출가능');

    // info02: <span>출판사</span><span>연도</span><span>청구기호</span>
    const info2Spans = [];
    if (info2Match) {
      const spanRegex = /<span[^>]*>([\s\S]*?)<\/span>/g;
      let m;
      while ((m = spanRegex.exec(info2Match[1])) !== null) {
        const t = stripTags(m[1]);
        if (t) info2Spans.push(t);
      }
    }

    // info03: 도서관명 + 소장위치 (직접 텍스트, span 아님)
    const libraryName = info3Match ? stripTags(info3Match[1]) : '';

    items.push({
      title,
      author: authorMatch ? stripTags(authorMatch[1]) : '',
      publisher: info2Spans[0] || '',
      callNo: info2Spans.find((s) => /\d{2,3}[.\-]/.test(s)) || '',
      libraryName,
      statusText,
      available,
    });
  }

  return items;
}

// Python 참조 코드 기반 스코어링: publisher(+100), author(+50), title exact(+30), title contains(+20)
function findBestMatch(items, title, author, publisher) {
  const normTitle = title.replace(/\s+/g, '').toLowerCase();
  const normAuthor = (author || '').replace(/\s+/g, '').toLowerCase();
  const normPub = (publisher || '').replace(/\s+/g, '').toLowerCase();
  let best = null;
  let bestScore = -1;

  for (const item of items) {
    let score = 0;
    const itTitle = item.title.replace(/\s+/g, '').toLowerCase();
    const itAuthor = item.author.replace(/\s+/g, '').toLowerCase();
    const itPub = item.publisher.replace(/\s+/g, '').toLowerCase();

    // 출판사 정확 매칭 (가장 강력한 식별자)
    if (normPub && itPub && normPub === itPub) score += 100;
    // 저자 포함 매칭 (앞 4자 이상)
    if (normAuthor.length >= 2 && itAuthor.includes(normAuthor.substring(0, Math.min(4, normAuthor.length)))) score += 50;
    // 제목 완전 일치
    if (normTitle && itTitle === normTitle) score += 30;
    // 제목 포함 (양방향)
    else if (normTitle && (itTitle.includes(normTitle) || normTitle.includes(itTitle))) score += 20;

    // 동점이면 대출가능 본을 우선 (한 권은 대출중, 다른 권은 대출가능인 경우 대비)
    if (score > bestScore || (score === bestScore && item.available && best && !best.available)) {
      bestScore = score;
      best = item;
    }
  }

  // 최소 제목 매칭은 있어야 유효한 결과로 인정
  return { best, bestScore };
}

// set-cookie 헤더에서 JSESSIONID 추출 (Node undici: getSetCookie 우선)
function extractSessionCookie(headers) {
  let cookies = [];
  if (typeof headers.getSetCookie === 'function') {
    cookies = headers.getSetCookie();
  }
  if (!cookies.length) {
    const raw = headers.get('set-cookie');
    if (raw) cookies = [raw];
  }
  for (const c of cookies) {
    const m = c.match(/JSESSIONID=[^;]+/i);
    if (m) return m[0];
  }
  // 폴백: 첫 번째 쿠키
  if (cookies.length) {
    const m = cookies[0].match(/[A-Za-z0-9_.]+=[^;]+/);
    if (m) return m[0];
  }
  return '';
}

const SPLIB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SPLIB_PAGE_SIZE = 10; // 사이트가 페이지당 10개 고정 (pageUnit 무시됨)
const SPLIB_MAX_PAGES = 5; // 최대 50건까지 탐색

// 결과 페이지에서 "검색결과 총 N건" 추출
function parseTotalCount(html) {
  const m = html.match(/검색결과\s*총\s*<span[^>]*>\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
}

// JSESSIONID 쿠키 획득: manual redirect로 302의 set-cookie까지 포착, 실패 시 follow 재시도
// diag 객체에 진단 정보를 기록한다.
async function getSplibSessionCookie(lib, diag) {
  const headers = { 'User-Agent': SPLIB_UA, Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' };
  for (const mode of ['manual', 'follow']) {
    try {
      const r = await fetch(lib.formUrl, { method: 'GET', headers, redirect: mode });
      if (diag) {
        diag.sessionStatus = r.status;
        diag.hasGetSetCookie = typeof r.headers.getSetCookie === 'function';
        diag.rawSetCookieLen = (r.headers.get('set-cookie') || '').length;
      }
      const c = extractSessionCookie(r.headers);
      if (c) return c;
    } catch (e) {
      if (diag) diag.sessionError = e.message;
    }
  }
  return '';
}

async function fetchSplibPage(lib, title, pageNo, cookie) {
  const params = new URLSearchParams({
    searchType: 'SIMPLE',
    searchCategory: 'BOOK',
    searchKey: 'ALL',
    currentPageNo: String(pageNo),
    searchKeyword: title,
  });
  const headers = {
    'User-Agent': SPLIB_UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: new URL(lib.searchUrl).origin,
    Referer: lib.formUrl,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
    'Accept-Language': 'ko-KR,ko;q=0.9',
  };
  if (cookie) headers['Cookie'] = cookie;

  const response = await fetch(lib.searchUrl, { method: 'POST', headers, body: params.toString() });
  const html = await response.text();
  // POST 응답이 새 세션 쿠키를 줄 수도 있음 (400 재시도용)
  const respCookie = extractSessionCookie(response.headers);
  return {
    status: response.status,
    items: parseSearchResults(html),
    total: parseTotalCount(html),
    respCookie,
  };
}

async function handleSplib(source, title, author, publisher, lib, res) {
  const queryStr = `${title} ${author || ''}`.trim();
  const diag = {};

  // Step 1: 검색폼 GET → JSESSIONID 획득 (없으면 검색 POST가 400 반환)
  let sessionCookie = await getSplibSessionCookie(lib, diag);

  // Step 2: 도서관 필터(searchLibraryArr)는 0건을 유발하므로 쓰지 않고,
  // 송파 전 도서관 결과를 페이지별로 받아 도서관명으로 필터링한다.
  // 대상 도서관 소장본은 뒤쪽 페이지에 있을 수 있으므로 페이지네이션 필수.
  const libItems = [];
  let total = 0;
  let lastStatus = 0;
  let pagesFetched = 0;
  let retried = false;

  for (let page = 1; page <= SPLIB_MAX_PAGES; page++) {
    let pageRes = await fetchSplibPage(lib, title, page, sessionCookie);

    // 쿠키 없이/만료로 400이 나면, 응답이 준 쿠키로 한 번 재시도
    if (pageRes.status === 400 && !retried) {
      retried = true;
      const freshCookie = pageRes.respCookie || (await getSplibSessionCookie(lib, diag));
      if (freshCookie) {
        sessionCookie = freshCookie;
        pageRes = await fetchSplibPage(lib, title, page, sessionCookie);
      }
    }

    lastStatus = pageRes.status;
    pagesFetched = page;
    if (page === 1) total = pageRes.total;

    for (const it of pageRes.items) {
      if (it.libraryName && it.libraryName.includes(lib.matchName)) libItems.push(it);
    }

    // 대상 도서관 소장본을 찾았으면 조기 종료
    if (libItems.length > 0) break;
    // 더 가져올 페이지가 없으면 종료
    if (page * SPLIB_PAGE_SIZE >= total || pageRes.items.length === 0) break;
  }

  console.log(
    `[splib ${source}] "${title}" → HTTP ${lastStatus}, total=${total}, ` +
      `pages=${pagesFetched}, ${lib.matchName} 소장=${libItems.length}`,
  );

  const { best, bestScore } = findBestMatch(libItems, title, author, publisher);
  // 제목이 최소한 포함(20점)되어야 유효 매칭으로 인정
  const matched = best !== null && bestScore >= 20;

  return res.status(200).json({
    source,
    libraryName: lib.name,
    query: queryStr,
    matched,
    result: matched ? best : null,
    _debug: {
      total,
      pagesFetched,
      libItems: libItems.length,
      bestScore,
      status: lastStatus,
      cookieSent: !!sessionCookie,
      retried,
      ...diag,
    },
    checkedAt: Math.floor(Date.now() / 1000),
  });
}

async function handleDoksero(source, title, author, publisher, lib, res) {
  const queryStr = `${title} ${author || ''}`.trim();
  const BASE = 'https://read365.edunet.net';
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Referer': `${BASE}/`,
    'Accept': 'application/json, text/plain, */*',
  };

  const API = `${BASE}/schome/service/readingActivitesMng/readingActivites`;

  // Step 1: bookList?searchWord=... 로 도서 목록 검색
  const listUrl = new URL(`${API}/bookList`);
  listUrl.searchParams.set('searchWord', title);
  listUrl.searchParams.set('neisCode', lib.neisCode);
  listUrl.searchParams.set('provCode', lib.provCode);
  listUrl.searchParams.set('pageSize', '10');
  listUrl.searchParams.set('pageIndex', '1');

  let listData;
  try {
    const listRes = await fetch(listUrl.toString(), { headers: HEADERS });
    const ct = listRes.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      return res.status(200).json({
        source, libraryName: lib.name, query: queryStr,
        matched: false, result: null, error: 'API_ENDPOINT_UNKNOWN',
        checkedAt: Math.floor(Date.now() / 1000),
      });
    }
    listData = await listRes.json();
  } catch (err) {
    return res.status(200).json({
      source, libraryName: lib.name, query: queryStr,
      matched: false, result: null, error: err.message,
      checkedAt: Math.floor(Date.now() / 1000),
    });
  }

  // 응답 구조 유연하게 파싱
  const bookList =
    listData?.list ||
    listData?.result?.list ||
    listData?.data ||
    listData?.books ||
    [];

  if (!bookList.length) {
    return res.status(200).json({
      source, libraryName: lib.name, query: queryStr,
      matched: false, result: null,
      checkedAt: Math.floor(Date.now() / 1000),
    });
  }

  // Python 참조 코드 기반 스코어링
  const normTitle = title.replace(/\s+/g, '').toLowerCase();
  const normAuthor = (author || '').replace(/\s+/g, '').toLowerCase();
  const normPub = (publisher || '').replace(/\s+/g, '').toLowerCase();
  let bestBook = null;
  let bestScore = -1;

  for (const item of bookList) {
    const iTitle = (item.title || item.bookTitle || item.bookNm || '').replace(/\s+/g, '').toLowerCase();
    const iAuthor = (item.author || item.bkAuthor || item.writerNm || '').replace(/\s+/g, '').toLowerCase();
    const iPub = (item.publisher || item.pubNm || item.press || '').replace(/\s+/g, '').toLowerCase();
    const bookKey = item.bookKey || item.bkKey || item.id;
    if (!bookKey) continue;

    let score = 0;
    if (normPub && iPub && normPub === iPub) score += 100;
    if (normAuthor.length >= 2 && iAuthor.includes(normAuthor.substring(0, Math.min(4, normAuthor.length)))) score += 50;
    if (normTitle && iTitle === normTitle) score += 30;
    else if (normTitle && (iTitle.includes(normTitle) || normTitle.includes(iTitle))) score += 20;

    if (score > bestScore) {
      bestScore = score;
      bestBook = { bookKey, title: iTitle, author: iAuthor, shelf: item.shelf || item.callNo || '' };
    }
  }

  if (!bestBook || bestScore < 0) {
    return res.status(200).json({
      source, libraryName: lib.name, query: queryStr,
      matched: false, result: null,
      checkedAt: Math.floor(Date.now() / 1000),
    });
  }

  // Step 2: state?bookKey=...&provCode=...&neisCode=... 로 대출 상태 확인
  const stateUrl = new URL(`${API}/state`);
  stateUrl.searchParams.set('bookKey', bestBook.bookKey);
  stateUrl.searchParams.set('provCode', lib.provCode);
  stateUrl.searchParams.set('neisCode', lib.neisCode);

  let available = false;
  let statusText = '소장';

  try {
    const stateRes = await fetch(stateUrl.toString(), { headers: HEADERS });
    if (stateRes.ok) {
      const ct = stateRes.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const stateData = await stateRes.json();
        const loanStatus =
          stateData?.loanStatus ||
          stateData?.status ||
          stateData?.rentalStatus ||
          stateData?.state ||
          '';
        statusText = loanStatus || '소장';
        available =
          loanStatus.includes('가능') ||
          loanStatus === 'Y' ||
          stateData?.available === true;
      }
    }
  } catch {
    // state 조회 실패 시 소장 사실만 반환
  }

  return res.status(200).json({
    source,
    libraryName: lib.name,
    query: queryStr,
    matched: true,
    result: {
      title: bestBook.title,
      author: bestBook.author,
      statusText,
      available,
      libraryName: lib.name,
      shelf: bestBook.shelf,
    },
    checkedAt: Math.floor(Date.now() / 1000),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { source, title, author, publisher } = req.body || {};

  if (!source || !LIBRARIES[source]) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const lib = LIBRARIES[source];

  try {
    if (lib.type === 'doksero') {
      return await handleDoksero(source, title, author, publisher, lib, res);
    }
    return await handleSplib(source, title, author, publisher, lib, res);
  } catch (err) {
    return res.status(200).json({
      source,
      libraryName: lib.name,
      query: `${title} ${author || ''}`.trim(),
      error: err.message,
      checkedAt: Math.floor(Date.now() / 1000),
    });
  }
}
