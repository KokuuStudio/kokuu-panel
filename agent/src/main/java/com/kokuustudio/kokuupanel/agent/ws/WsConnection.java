package com.kokuustudio.kokuupanel.agent.ws;

import java.net.URI;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

/**
 * 一次连接尝试的 WebSocket 客户端。
 *
 * <p>每次重连都新建一个实例，不复用 —— Java-WebSocket 的 {@code reconnect()}
 * 会复用同一个 client 对象，重连失败后内部状态（readyState、连接对象）容易
 * 停在半路，排障时看到的现象和真实原因对不上。
 *
 * <p>所有回调都直接转给 {@link ConnectionManager}，这一层只负责转发。
 * 注意 {@code onMessage} / {@code onClose} 跑在 WS 读线程上，
 * 里面**不能**碰 Bukkit 的玩家 API。
 */
public final class WsConnection extends WebSocketClient {

    private final ConnectionManager manager;

    public WsConnection(URI uri, ConnectionManager manager) {
        super(uri);
        this.manager = manager;
        // 我们不从子协议协商任何东西：协议 §2 明确「不使用子协议」。
        setTcpNoDelay(true);
    }

    @Override
    public void onOpen(ServerHandshake handshake) {
        manager.onOpen(this);
    }

    @Override
    public void onMessage(String message) {
        manager.onMessage(this, message);
    }

    @Override
    public void onClose(int code, String reason, boolean remote) {
        manager.onClose(this, code, reason, remote);
    }

    @Override
    public void onError(Exception ex) {
        manager.onError(this, ex);
    }
}
