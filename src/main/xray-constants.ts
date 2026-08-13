// Shared xray loopback ports — must match config-builder inbounds + api block.
// Offset from heretic-vpn defaults (7890/8086) to avoid dev-machine conflicts.
export const XRAY_SOCKS_HOST = '127.0.0.1'
export const XRAY_SOCKS_PORT = 7893
/** HTTP inbound — Windows WinINET system proxy (Chrome/Edge/Facebook). */
export const XRAY_HTTP_PORT = 7894
export const XRAY_GRPC_HOST = '127.0.0.1'
export const XRAY_GRPC_PORT = 8088
export const XRAY_GRPC_ADDR = `${XRAY_GRPC_HOST}:${XRAY_GRPC_PORT}`
export const XRAY_SOCKS_PROXY = `socks5h://${XRAY_SOCKS_HOST}:${XRAY_SOCKS_PORT}`
