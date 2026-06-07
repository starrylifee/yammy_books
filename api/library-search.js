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
  // [^>]* 로 class, id 등 추가 속성 허용
  const blockRegex = /<li[^>]*>\s*<div[^>]*class="[^"]*bookArea[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[1];

    const titleMatch = block.match(/<span[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    if (!titleMatch) continue;
    const title = stripTags(titleMatch[1]);

    const authorMatch = block.match(/<div[^>]*class="[^"]*book_info[^"]*info01[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const info2Match = block.match(/<div[^>]*class="[^"]*book_info[^"]*info02[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const info3Match = block.match(/<div[^>]*class="[^"]*book_info[^"]*info03[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const statusMatch = block.match(/<strong[^>]*class="([^"]+)"[^>]*>([\s\S]*?)<\/strong>/);

    const spanRegex = /<span[^>]*>([\s\S]*?)<\/span>/g;
    const info2Spans = [];
    if (info2Match) {
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

    const statusText = statusMatch ? stripTags(statusMatch[2]) : '';
    const statusClass = statusMatch ? statusMatch[1] : '';
    const available = statusClass.includes('okRent') || statusText.includes('대출가능');

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

function findBestMatch(items, title, author) {
  const normTitle = title.replace(/\s+/g, '');
  const normAuthor = (author || '').replace(/\s+/g, '');
  let best = null;
  let bestScore = -1;

  for (const item of items) {
    let score = 0;
    const itTitle = item.title.replace(/\s+/g, '');
    const itAuthor = item.author.replace(/\s+/g, '');
    // 제목 포함 여부 (양방향)
    if (normTitle && (itTitle.includes(normTitle) || normTitle.includes(itTitle))) score += 2;
    // 저자 앞 2글자 매칭
    if (normAuthor && normAuthor.length >= 2 && itAuthor.includes(normAuthor.substring(0, 2))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return { best, bestScore };
}

async function handleSplib(source, title, author, lib, res) {
  const queryStr = `${title} ${author || ''}`.trim();
  const params = new URLSearchParams({
    searchType: 'SIMPLE',
    searchCategory: 'BOOK',
    searchKey: 'TITLE',
    searchKeyword: queryStr,
    searchLibraryArr: lib.libraryCode,
  });

  const response = await fetch(lib.searchUrl, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: new URL(lib.searchUrl).origin,
      Referer: lib.searchUrl.replace('plusSearchResultList.do', 'plusSearchSimple.do'),
    },
    body: params.toString(),
  });

  const html = await response.text();
  const items = parseSearchResults(html);
  const { best, bestScore } = findBestMatch(items, title, author);

  return res.status(200).json({
    source,
    libraryName: lib.name,
    query: queryStr,
    matched: best !== null && bestScore >= 0,
    result: best,
    checkedAt: Math.floor(Date.now() / 1000),
  });
}

async function handleDoksero(source, title, author, lib, res) {
  const queryStr = `${title} ${author || ''}`.trim();
  const BASE = 'https://read365.edunet.net';
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Referer': `${BASE}/`,
    'Accept': 'application/json, text/plain, */*',
  };

  // Step 1: bookList?searchWord=... 로 도서 목록 검색
  const listUrl = new URL(`${BASE}/bookList`);
  listUrl.searchParams.set('searchWord', title);
  listUrl.searchParams.set('provCode', lib.provCode);
  listUrl.searchParams.set('neisCode', lib.neisCode);

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

  // 제목 기준 최적 매칭 도서 선택
  const normTitle = title.replace(/\s+/g, '');
  const normAuthor = (author || '').replace(/\s+/g, '');
  let bestBook = null;
  let bestScore = -1;

  for (const item of bookList) {
    const iTitle = (item.title || item.bookTitle || item.bookNm || '').replace(/\s+/g, '');
    const iAuthor = (item.author || item.bkAuthor || item.writerNm || '').replace(/\s+/g, '');
    const bookKey = item.bookKey || item.bkKey || item.id;
    if (!bookKey) continue;

    let score = 0;
    if (normTitle && (iTitle.includes(normTitle) || normTitle.includes(iTitle))) score += 2;
    if (normAuthor && normAuthor.length >= 2 && iAuthor.includes(normAuthor.substring(0, 2))) score += 1;

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
  const stateUrl = new URL(`${BASE}/state`);
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

  const { source, title, author } = req.body || {};

  if (!source || !LIBRARIES[source]) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const lib = LIBRARIES[source];

  try {
    if (lib.type === 'doksero') {
      return await handleDoksero(source, title, author, lib, res);
    }
    return await handleSplib(source, title, author, lib, res);
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
