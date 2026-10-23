/* Pages Function：把 /ws WebSocket 升级请求转发到实时 Worker（feihua-realtime）。
   网页主体由 Pages 托管，浏览器直连 workers.dev 不通，因此 WS 统一走 pages.dev 同域。 */
export async function onRequest(context) {
  const url = new URL(context.request.url)
  const target =
    'https://feihua-realtime.tulin5937.workers.dev' + url.pathname + url.search
  return fetch(target, context.request)
}
