// ============================================
// Vercel Serverless Function — 도서관 검색 프록시
// ============================================

const LIBRARIES = {
  spclib: {
    name: '송파어린이도서관',
    type: 'splib',
    searchUrl: 'https://www.splib.or.kr/spclib/menu/10243/program/30001/plusSearchResultList.do',
    libraryCode: 'MA',
  },
  sp2lib: {
    name: '소나무언덕2호도서관',
    type: 'splib',
    searchUrl: 'https://www.splib.or.kr/sp2lib/menu/10488/program/30001/plusSearchResultList.do',
    libraryCode: 'BB',
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

  // bookArea div 기준으로 분리 — li 직하위 여부 무관
  const blockRegex = /<div[^>]*class="[^"]*\bbookArea\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[1];

    // 제목: span.title 또는 book_name 안의 a 태그
    let titleRaw = '';
    const titleSpan = block.match(/<span[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    if (titleSpan) {
      titleRaw = stripTags(titleSpan[1]);
    } else {
      const bookNameA = block.match(/<[^>]*class="[^"]*book_name[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
      if (bookNameA) titleRaw = stripTags(bookNameA[1]);
    }
    if (!titleRaw) continue;
    // 앞 번호 제거 (예: "1. 어린왕자" → "어린왕자")
    const title = titleRaw.replace(/^\s*\d+\.\s*/, '').trim();
    if (!title) continue;

    const authorMatch = block.match(/<div[^>]*class="[^"]*book_info[^"]*info01[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const info2Match = block.match(/<div[^>]*class="[^"]*book_info[^"]*info02[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const info3Match = block.match(/<div[^>]*class="[^"]*book_info[^"]*info03[^"]*"[^>]*>([\s\S]*?)<\/div>/);

    // 상태: class 유무 상관없이 strong 태그 내용 확인
    const statusMatch = block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    const statusClassMatch = statusMatch ? statusMatch[0].match(/class="([^"]+)"/) : null;
    const statusText = statusMatch ? stripTags(statusMatch[1]) : '';
    const statusClass = statusClassMatch ? statusClassMatch[1] : '';
    const available = statusClass.includes('okRent') || statusText.includes('대출가능');

    const info2Spans = [];
    if (info2Match) {
      const spanRegex = /<span[^>]*>([\s\S]*?)<\/span>/g;
      let m;
      while ((m = spanRegex.exec(info2Match[1])) !== null) {
        info2Spans.push(stripTags(m[1]));
      }
    }
    const info3Spans = [];
    if (info3Match) {
      const regex3 = /<span[^>]*>([\s\S]*?)<\/span>/g;
      let m;
      while ((m = regex3.exec(info3Match[1])) !== null) {
        info3Spans.push(stripTags(m[1]));
      }
    }

    items.push({
      title,
      author: authorMatch ? stripTags(authorMatch[1]) : '',
      publisher: info2Spans[0] || '',
      callNo: info2Spans[2] || '',
      libraryName: info3Spans[0] || '',
      shelf: info3Spans[1] || '',
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

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  // 최소 제목 매칭은 있어야 유효한 결과로 인정
  return { best, bestScore };
}

async function handleSplib(source, title, author, publisher, lib, res) {
  const queryStr = `${title} ${author || ''}`.trim();
  const simpleUrl = lib.searchUrl.replace('plusSearchResultList.do', 'plusSearchSimple.do');
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // Step 1: GET 검색폼 → JSESSIONID 획득 (Python Playwright과 동일한 흐름)
  let sessionCookie = '';
  try {
    const sessionRes = await fetch(simpleUrl, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      redirect: 'follow',
    });
    const setCookie = sessionRes.headers.get('set-cookie') || '';
    // JSESSIONID 우선, 없으면 첫 번째 쿠키 사용
    const m = setCookie.match(/JSESSIONID=[^;]+/i) || setCookie.match(/[A-Za-z0-9_]+=\S[^;]*/);
    if (m) sessionCookie = m[0];
    console.log(`[splib ${source}] session GET status=${sessionRes.status} cookie="${sessionCookie}"`);
  } catch (e) {
    console.log(`[splib ${source}] session GET failed: ${e.message}`);
  }

  // Step 2: POST 검색 (제목만, 저자는 매칭 스코어에서만 사용)
  const params = new URLSearchParams({
    searchType: 'SIMPLE',
    searchCategory: 'BOOK',
    searchKey: 'TITLE',
    searchKeyword: title,
    searchLibraryArr: lib.libraryCode,
  });

  const reqHeaders = {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: new URL(lib.searchUrl).origin,
    Referer: simpleUrl,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
    'Accept-Language': 'ko-KR,ko;q=0.9',
  };
  if (sessionCookie) reqHeaders['Cookie'] = sessionCookie;

  const response = await fetch(lib.searchUrl, {
    method: 'POST',
    headers: reqHeaders,
    body: params.toString(),
  });

  const html = await response.text();
  const items = parseSearchResults(html);

  // 디버그 로그 — vercel dev 콘솔에서 확인
  console.log(`[splib ${source}] "${title}" → HTTP ${response.status}, htmlLen=${html.length}, items=${items.length}`);
  if (items.length === 0) {
    console.log(`[splib ${source}] HTML snippet: ${html.substring(0, 600)}`);
  }

  const { best, bestScore } = findBestMatch(items, title, author, publisher);

  return res.status(200).json({
    source,
    libraryName: lib.name,
    query: queryStr,
    matched: best !== null && bestScore >= 0,
    result: best,
    _debug: { items: items.length, htmlLen: html.length },
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
