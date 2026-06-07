// ============================================
// 도서관 검색 모듈 — Vercel Serverless 프록시 호출
// ============================================

const LIBRARY_SOURCES = ['spclib', 'sp2lib', 'bdllib'];

async function checkSingleSource(title, author, publisher, source) {
  try {
    const res = await fetch('/api/library-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, title, author, publisher }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    return {
      source,
      error: err.message,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }
}

/**
 * 단일 책에 대해 모든 도서관 소스 조회
 */
export async function checkBook(title, author, publisher) {
  const results = {};
  for (const source of LIBRARY_SOURCES) {
    results[source] = await checkSingleSource(title, author, publisher, source);
  }
  return results;
}

/**
 * 여러 책 일괄 조회 (모든 도서관)
 */
export async function checkMultipleBooks(books, onResult) {
  for (const book of books) {
    const availability = await checkBook(book.title, book.author, book.publisher);
    await onResult(book.id, availability);
  }
}

/**
 * 여러 책을 특정 도서관 하나만 조회
 * @param {string} source - 'spclib' | 'sp2lib' | 'bdllib'
 * @param {(bookId: string, source: string, result: object) => Promise<void>} onResult
 */
export async function checkBooksForSource(books, source, onResult) {
  for (const book of books) {
    const result = await checkSingleSource(book.title, book.author, book.publisher, source);
    await onResult(book.id, source, result);
  }
}
