/**
 * Host half of dsh-minimax-autoread.
 *
 * All the work happens in `client.js`, which watches the active Session's event
 * stream and asks the `dsh-minimax-voice` HTTP surface to synthesize each
 * finished assistant reply. The host half only declares the plugin so the
 * Cordis row loads and the client bundle gets mounted.
 */
export const name = 'minimax-autoread'

export function apply(ctx) {
  ctx.logger.info('minimax-autoread ready: client half drives auto reading via /mmvoice/api')
}
