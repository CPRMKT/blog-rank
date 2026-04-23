export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { blogId } = req.query;
  if (!blogId) return res.status(400).json({ error: 'blogId required' });

  try {
    const rssUrl = `https://rss.blog.naver.com/${blogId}.xml`;
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BlogRankChecker/1.0)'
      }
    });

    if (!response.ok) {
      return res.status(404).json({ error: '블로그를 찾을 수 없습니다' });
    }

    const xml = await response.text();

    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const match of itemMatches) {
      const itemXml = match[1];

      const title = decodeHtml(extract(itemXml, 'title'));
      const pubDate = extract(itemXml, 'pubDate');
      const link = extract(itemXml, 'link') || extractCdata(itemXml, 'link');

      if (title) {
        items.push({
          title: title.replace(/<[^>]+>/g, '').trim(),
          time: formatDate(pubDate),
          rawDate: pubDate,
          link: link ? link.trim() : `https://blog.naver.com/${blogId}`
        });
      }

      if (items.length >= 10) break;
    }

    return res.status(200).json({ blogId, items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
    || xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function extractCdata(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i'));
  return m ? m[1].trim() : '';
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);

    if (diff < 60) return '방금 전';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;

    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  } catch {
    return dateStr;
  }
}
