// 순위 목록 GraphQL 판별은 playwright 없이 돌아야 한다(fixture 테스트용)으로 별도 파일로 분리했다.
// 테스트: node scraper/tests/capture.test.mjs

// ── 순위 목록 GraphQL 판별 ──────────────────────────────────────────────
// 리스트 페이지에는 순위 목록 말고도 '신규 오픈' 같은 다른 모듈의 GraphQL이 함께 뜬다.
// 그중 getOpeningRestaurants는 input(start/display)까지 갖고 있어 모양으로는 구분되지 않는다.
// 2026-10-30~11-09에 그걸 잡는 바람에 '신규 오픈 매장 목록'이 순위로 저장됐다(오염 1,199건).
// 그래서 모양이 아니라 '연산자 이름 허용 목록'으로 채택한다. 이름이 바뀌면 0곳으로 넘어가지 말고
// 에러를 내서 사람이 알아채게 한다. 네이버가 이름을 바꾸면 PLACE_LIST_OPS로 재배포 없이 추가 가능.
export const LIST_OPS = new Set(
  ['getRestaurants', 'getPlaceListBeauty', 'getNxList']   // 2026-11-14 실측(restaurant/hairshop/hospital)
    .concat(String(process.env.PLACE_LIST_OPS || '').split(',').map((x) => x.trim()).filter(Boolean))
);

export const findInput = (v) =>
  (v && (v.input || v.restaurantListInput || v.businessListInput || v.hairShopListInput || v.hospitalListInput || v.cafeListInput)) || null;

export function isListOp(op) {
  if (!op || !op.variables) return false;
  const name = String(op.operationName || '');
  if (!LIST_OPS.has(name)) return false;
  if (/opening/i.test(name)) return false;              // 허용 목록이 느슨해져도 한 겹 더
  const inp = findInput(op.variables);
  if (!inp) return false;
  if (String(inp.filterOpening) === 'true') return false; // 오픈 모듈 표식
  return true;
}

/** 캡처 후보 postData를 보고 채택 여부와 본 연산자 이름들을 돌려준다. */
export function inspectCapture(postData) {
  let b;
  try { b = JSON.parse(postData); } catch { return { accept: false, ops: [] }; }
  const arr = Array.isArray(b) ? b : [b];
  const ops = arr.map((op) => String((op && op.operationName) || '?')).filter(Boolean);
  return { accept: arr.some((op) => isListOp(op)), ops };
}

// 페이지(50건) 사이 딜레이 350ms. 150ms로 줄였던 9/18~19에 수집 45분차부터 약 35분간 네이버가 빈 목록을
// 연속 반환(0곳보류 10→55→56건, 이전 5회 연속 0건). 짧은 A/B로는 누적 속도 제한이 재현되지 않으므로
// 낮추려면 전체 크론 1회분(300여 키워드) 규모로 검증할 것.
const PAGE_DELAY_MS = parseInt(process.env.PLACE_PAGE_DELAY_MS || '350', 10);

// 키워드로 플레이스 vertical(리스트 경로) 판별. m.place는 generic list가 없어
// 업종 vertical 경로로 접근해야 검색 결과가 렌더된다. 기본은 restaurant.
function listPath(keyword) {
  const k = String(keyword || '');
  if (/미용실|헤어|네일|왁싱|피부관리|에스테틱|뷰티|메이크업|반영구|속눈썹/.test(k)) return 'hairshop';
  if (/병원|의원|치과|한의원|약국|정형외과|피부과|이비인후|안과|산부인과/.test(k)) return 'hospital';
  if (/카페|커피|디저트|베이커리|빵집|브런치/.test(k)) return 'cafe';
  return 'restaurant';
}
