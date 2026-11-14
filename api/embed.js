// api/embed.js — 임베드(끼워 넣기) 전용 페이지.
//
// 왜 정적 파일이 아니라 함수인가: 끼워 넣기를 허용할 도메인을 환경변수로 두고 응답 헤더
// (Content-Security-Policy: frame-ancestors)에 그대로 실어야 하기 때문. vercel.json 헤더는
// 빌드 시점에 고정돼서 운영 도메인이 생길 때마다 코드를 고쳐야 한다.
//
// 환경변수 EMBED_ALLOWED_ORIGINS — 공백 또는 쉼표로 여러 개. 예:
//   https://cpr-saas-staging.vercel.app https://os.cprmkt.kr
//
// 이 페이지는 네이버로 요청을 보내지 않는다. 호출은 /api/db(embed_data) 한 번뿐이고,
// 자동 수집·재시도·큐는 아예 들어 있지 않다(index.html과 코드를 공유하지 않는다).
const DEFAULT_ORIGINS = 'https://cpr-saas-staging.vercel.app https://blog-rank-phi.vercel.app';

export default function handler(req, res) {
  const allowed = String(process.env.EMBED_ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(/[\s,]+/).map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);

  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${allowed.join(' ')}`);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // X-Frame-Options는 일부러 넣지 않는다(넣으면 frame-ancestors보다 먼저 막힌다).
  res.status(200).send(page(allowed));
}

const page = (allowed) => `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>매장 순위</title>
<style>
:root{--brand:#2563eb;--brand-ink:#1d4ed8;--brand-soft:#eff6ff;--ink:#0f172a;--text:#334155;--muted:#64748b;--faint:#94a3b8;--line:#e2e8f0;--line-2:#f1f5f9;--surface:#fff;--surface-2:#f8fafc;--ok:#16a34a;--down:#2563eb;--up:#dc2626}
*{box-sizing:border-box}
body{margin:0;padding:14px;background:transparent;color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;-webkit-font-smoothing:antialiased}
.hd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.hd .nm{font-size:17px;font-weight:800;color:var(--ink);letter-spacing:-.02em}
.hd .ct{font-size:12px;color:var(--muted)}
.sec{font-size:12px;font-weight:700;color:var(--muted);margin:16px 0 8px;letter-spacing:.02em}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.kw{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:8px}
.days{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--line-2);border:1px solid var(--line-2);border-radius:8px;overflow:hidden}
.d{background:var(--surface);padding:7px 4px;text-align:center;min-height:52px}
.d .dt{font-size:10.5px;color:var(--muted);margin-bottom:3px}
.d .rk{font-size:16px;font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums}
.d .rk.t1{color:var(--ok)}
.d .none{color:var(--faint);font-weight:600;font-size:15px}
.d .nc{font-size:10.5px;color:var(--faint);border-bottom:1px dashed var(--faint);display:inline-block}
.d .chg{font-size:10px;font-weight:700;margin-top:1px}
.chg.up{color:var(--up)}.chg.down{color:var(--down)}.chg.flat{color:var(--faint)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{background:var(--surface-2);color:var(--muted);text-align:left;padding:8px 10px;font-weight:600;font-size:11px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-top:1px solid var(--line-2)}
td.r{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink)}
.msg{padding:28px 16px;text-align:center;color:var(--muted);font-size:13px}
.note{font-size:11px;color:var(--faint);margin-top:10px;line-height:1.6}
.tag{display:inline-block;background:var(--brand-soft);color:var(--brand-ink);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600}
</style></head>
<body>
<div id="root"><div class="msg">불러오는 중…</div></div>
<script>
(function(){
  var ALLOWED = ${JSON.stringify(allowed)};
  var root = document.getElementById('root');
  var esc = function(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); };
  var token = new URLSearchParams(location.search).get('token') || '';

  // 부모 창 origin: 허용 목록에 있을 때만 높이를 알린다(와일드카드 * 는 쓰지 않는다).
  var parentOrigin = (function(){
    try{
      var ao = location.ancestorOrigins;
      if (ao && ao.length) return ALLOWED.indexOf(ao[0]) >= 0 ? ao[0] : null;
    }catch(e){}
    try{
      if (document.referrer){ var o = new URL(document.referrer).origin; return ALLOWED.indexOf(o) >= 0 ? o : null; }
    }catch(e){}
    return null;
  })();
  // 부모가 보내는 메시지는 듣지 않는다(message 리스너 없음).
  function tellHeight(){
    if (!parentOrigin) return;
    var h = Math.ceil(document.documentElement.scrollHeight);
    try{ parent.postMessage({ type: 'blogrank-embed-height', height: h }, parentOrigin); }catch(e){}
  }

  var KST = function(d){ return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(d); };
  function lastDays(n){ var out=[], t=new Date(); for(var i=0;i<n;i++){ var d=new Date(t.getTime()-i*86400000); out.push(KST(d)); } return out; }
  function wd(s){ var w=['일','월','화','수','목','금','토'][new Date(s+'T00:00:00+09:00').getDay()]; return s.slice(5).replace('-','/')+'('+w+')'; }

  function render(j){
    var days = lastDays(12);
    var h = '<div class="hd"><span class="nm">'+esc(j.store.name)+'</span>'
      + (j.store.category?'<span class="ct">'+esc(j.store.category)+'</span>':'')
      + (j.store.address?'<span class="ct">'+esc(j.store.address)+'</span>':'') + '</div>';

    // 플레이스 순위
    h += '<div class="sec">플레이스 순위 <span class="tag">'+(j.placeKeywords||[]).length+'개 키워드</span></div>';
    if(!(j.placeKeywords||[]).length){ h += '<div class="card"><div class="msg">등록된 플레이스 키워드가 없습니다.</div></div>'; }
    var byKw = {};
    (j.placeRows||[]).forEach(function(r){ (byKw[r.keyword]=byKw[r.keyword]||{})[r.checked_date]=r; });
    (j.placeKeywords||[]).forEach(function(k){
      var created = k.created_at ? KST(new Date(k.created_at)) : '';
      var got = {}; ((j.collected||{})[k.keyword]||[]).forEach(function(d){ got[d]=1; });
      h += '<div class="card"><div class="kw">'+esc(k.keyword)+'</div><div class="days">';
      days.forEach(function(d,i){
        var row = (byKw[k.keyword]||{})[d];
        var inner;
        if(row && row.rank!=null){
          var prev=null;
          for(var x=i+1;x<days.length;x++){ var p=(byKw[k.keyword]||{})[days[x]]; if(p&&p.rank!=null){ prev=p; break; } }
          var chg='';
          if(prev){ var diff=prev.rank-row.rank; chg = diff>0?'<div class="chg up">▲'+diff+'</div>':diff<0?'<div class="chg down">▼'+(-diff)+'</div>':'<div class="chg flat">-</div>'; }
          inner = '<div class="rk'+(row.rank<=3?' t1':'')+'">'+row.rank+'</div>'+chg;
        } else if(created && d < created){ inner = '';
        } else if(!got[d]){ inner = '<span class="nc" title="그날 수집 기록이 없습니다">수집 안 됨</span>';
        } else { inner = '<div class="none">-</div>'; }
        h += '<div class="d"><div class="dt">'+wd(d)+'</div>'+inner+'</div>';
      });
      h += '</div></div>';
    });

    // 블로그 순위
    h += '<div class="sec">블로그 순위 <span class="tag">'+(j.blogKeywords||[]).length+'개 키워드</span></div>';
    var bLatest = {};
    (j.blogRows||[]).forEach(function(r){ if(!bLatest[r.keyword] || r.checked_date > bLatest[r.keyword].checked_date) bLatest[r.keyword]=r; });
    if(!(j.blogKeywords||[]).length){ h += '<div class="card"><div class="msg">등록된 블로그 키워드가 없습니다.</div></div>'; }
    else {
      h += '<div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>키워드</th><th style="text-align:right">순위</th><th style="text-align:right">확인일</th></tr></thead><tbody>';
      (j.blogKeywords||[]).forEach(function(k){
        var r = bLatest[k];
        h += '<tr><td>'+esc(k)+'</td><td class="r">'+(r&&r.rank!=null?r.rank+'위':'<span style="color:var(--faint);font-weight:600">미노출</span>')+'</td>'
          +  '<td class="r" style="font-weight:400;color:var(--muted)">'+(r?wd(r.checked_date):'-')+'</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '<div class="note">순위는 매일 새벽·저녁 자동 수집분입니다. <b>수집 안 됨</b>은 그날 수집 기록이 없다는 뜻이고, <b>-</b>는 수집은 됐지만 노출되지 않았다는 뜻입니다.</div>';
    root.innerHTML = h;
    tellHeight();
  }

  if(!token){ root.innerHTML = '<div class="msg">표시할 수 없는 링크입니다.</div>'; tellHeight(); return; }
  fetch('/api/db', { method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store',
      body: JSON.stringify({ action:'embed_data', data:{ token: token } }) })
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(!j || !j.ok){ root.innerHTML = '<div class="msg">'+esc((j&&j.error)||'표시할 수 없는 링크입니다.')+'</div>'; tellHeight(); return; }
      render(j);
    })
    .catch(function(){ root.innerHTML = '<div class="msg">잠시 후 다시 열어 주세요.</div>'; tellHeight(); });

  if (window.ResizeObserver) new ResizeObserver(tellHeight).observe(document.documentElement);
  window.addEventListener('load', tellHeight);
})();
</script>
</body></html>`;
