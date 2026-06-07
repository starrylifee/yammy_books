// ============================================
// 도서관 검색 모듈 — Vercel Serverless 프록시 호출
// ============================================

const LIBRARY_SOURCES = ['spclib', 'sp2lib'];

/**
 * 단일 책에 대해 모든 도서관 소스 조회
 * @returns {{ spclib: object, sp2lib: object }}
 */
export async function checkBook(title, author) {
  const results = {};

  for (const source of LIBRARY_SOURCES) {
    try {
      const res = await fetch('/api/library-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, title, author }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      results[source] = await res.json();
    } catch (err) {
      results[source] = {
        source,
        error: err.message,
        checkedAt: Math.floor(Date.now() / 1000),
      };
    }
  }

  return results;
}

/**
 * 여러 책 일괄 조회
 * @param {Array<{id: string, title: string, author: string}>} books
 * @param {(bookId: string, availability: object) => Promise<void>} onResult - 각 책 결과 콜백
 */
export async function checkMultipleBooks(books, onResult) {
  for (const book of books) {
    const availability = await checkBook(book.title, book.author);
    await onResult(book.id, availability);
  }
}
