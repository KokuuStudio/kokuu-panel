package com.kokuustudio.kokuupanel.agent.ws;

import com.kokuustudio.kokuupanel.agent.AgentConfig;
import com.kokuustudio.kokuupanel.agent.punish.PunishSnapshot;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import java.util.List;
import java.util.logging.Logger;

/**
 * 连接层需要宿主提供的全部东西。
 *
 * <p>存在的理由有两个：
 * <ol>
 *   <li><b>解耦</b>：连接层本来就不该认识 Bukkit —— 它只做「连平台、握手、心跳、
 *       重连、收发帧」。玩家/世界/调度器都属于模块层。</li>
 *   <li><b>可测</b>：不启动 MC 服务端就能把 {@link ConnectionManager} 接到一个真实的
 *       WebSocket 服务端上跑端到端验证。生产实现是 {@code KokuuAgentPlugin}。</li>
 * </ol>
 */
public interface ConnectionHost {

    Logger logger();

    AgentConfig config();

    RpcDispatcher dispatcher();

    PunishSnapshot punishSnapshot();

    /** 本节点声明的能力列表（hello 里上报）。 */
    List<String> declaredCapabilities();

    /** hello 响应里下发的经济后端信息。 */
    void applyEconomyInfo(String backend, String currency);

    /** 插件版本，填进 hello 的 {@code agent.version}。 */
    String agentVersion();

    /** 服务端版本，填进 hello 的 {@code agent.mcVersion}（Bukkit.getBukkitVersion()）。 */
    String mcVersion();

    /** 服务端品牌，填进 hello 的 {@code agent.brand}（Bukkit.getName()）。 */
    String brand();
}
