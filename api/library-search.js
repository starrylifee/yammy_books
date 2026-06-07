// ============================================
// Vercel Serverless Function — 송파 도서관 검색 프록시
// 프로토타입 app.py의 search_library + parse_search_results 로직 이식
// ============================================

const LIBRARIES = {
  spclib: {
    name: '송파어린이도서관',
    searchUrl:
      'https://www.splib.or.kr/spclib/menu/10243/program/30001/plusSearchResultList.do',
    libraryCode: 'MA',
  },
  sp2lib: {
    name: '소나무언덕2호도서관',
    searchUrl:
      'https://www.splib.or.kr/sp2lib/menu/10488/program/30001/plusSearchResultList.do',
    libraryCode: 'BB',
  },
};

/**
 * HTML 태그 제거 + 엔티티 디코딩
 */
function stripTags(html) {
  let text = html.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/<[^>]+>/g, '');
  // 기본 HTML 엔티티 디코딩
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 검색 결과 HTML에서 도서 목록 파싱
 */
function parseSearchResults(html) {
  const items = [];
  const blockRegex = /<li>\s*<div class="bookArea">([\s\S]*?)<\/li>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const block = blockMatch[1];

    const titleMatch = block.match(/<span class="title">([\s\S]*?)<\/span>/);
    if (!titleMatch) continue;
    const title = stripTags(titleMatch[1]);

    const authorMatch = block.match(
      /<div class="book_info info01">([\s\S]*?)<\/div>/
    );
    const info2Match = block.match(
      /<div class="book_info info02">([\s\S]*?)<\/div>/
    );
    const info3Match = block.match(
      /<div class="book_info info03">([\s\S]*?)<\/div>/
    );
    const statusMatch = block.match(
      /<strong class="([^"]+)">([\s\S]*?)<\/strong>/
    );

    const spanRegex = /<span>([\s\S]*?)<\/span>/g;
    const info2Spans = [];
    if (info2Match) {
      let m;
      while ((m = spanRegex.exec(info2Match[1])) !== null) {
        info2Spans.push(stripTags(m[1]));
      }
    }
    const info3Spans = [];
    if (info3Match) {
      const regex3 = /<span>([\s\S]*?)<\/span>/g;
      let m;
      while ((m = regex3.exec(info3Match[1])) !== null) {
        info3Spans.push(stripTags(m[1]));
      }
    }

    const statusText = statusMatch ? stripTags(statusMatch[2]) : '';
    const statusClass = statusMatch ? statusMatch[1] : '';
    const available =
      statusClass.includes('okRent') || statusText.includes('대출가능');

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

export default async function handler(req, res) {
  // CORS 헤더
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
  const queryStr = `${title} ${author || ''}`.trim();

  try {
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
        Referer: lib.searchUrl.replace(
          'plusSearchResultList.do',
          'plusSearchSimple.do'
        ),
      },
      body: params.toString(),
    });

    const html = await response.text();
    const items = parseSearchResults(html);

    // 제목/저자 매칭 점수 기반 최적 결과 선택
    const normTitle = title.replace(/\s+/g, '');
    const normAuthor = (author || '').replace(/\s+/g, '');
    let best = null;
    let bestScore = -1;

    for (const item of items) {
      let score = 0;
      const itTitle = item.title.replace(/\s+/g, '');
      const itAuthor = item.author.replace(/\s+/g, '');
      if (normTitle && itTitle.includes(normTitle)) score += 2;
      if (normAuthor && normAuthor.length >= 2 && itAuthor.includes(normAuthor.substring(0, 2)))
        score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return res.status(200).json({
      source,
      libraryName: lib.name,
      query: queryStr,
      matched: best !== null,
      result: best,
      checkedAt: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    return res.status(200).json({
      source,
      libraryName: lib.name,
      query: queryStr,
      error: err.message,
      checkedAt: Math.floor(Date.now() / 1000),
    });
  }
}
