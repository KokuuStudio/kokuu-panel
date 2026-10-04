package com.kokuustudio.kokuupanel.agent.modules;

import com.kokuustudio.kokuupanel.agent.Capabilities;
import com.kokuustudio.kokuupanel.agent.hooks.LpBridge;
import com.kokuustudio.kokuupanel.agent.hooks.LuckPermsHook;
import com.kokuustudio.kokuupanel.agent.model.LpModels.LpGroup;
import com.kokuustudio.kokuupanel.agent.model.LpModels.LpUser;
import com.kokuustudio.kokuupanel.agent.model.SmallModels;
import com.kokuustudio.kokuupanel.agent.protocol.AgentException;
import com.kokuustudio.kokuupanel.agent.protocol.ErrorCode;
import com.kokuustudio.kokuupanel.agent.rpc.MainThreadExecutor;
import com.kokuustudio.kokuupanel.agent.rpc.Params;
import com.kokuustudio.kokuupanel.agent.rpc.RpcDispatcher;
import java.util.List;

/**
 * LuckPerms 方法（协议 §5.5）。
 *
 * <p>两个硬要求：
 * <ol>
 *   <li><b>运行时探测</b>：未安装或 API 版本不兼容一律回 {@code NO_LUCKPERMS}，
 *       而不是抛 {@code NoClassDefFoundError}。探测在 {@link LuckPermsHook} 里做，
 *       这里只负责把链接错误也收敛成 {@code NO_LUCKPERMS}（万一 API 是「类在但方法没了」
 *       的那种不兼容）。</li>
 *   <li><b>写操作如实返回 {@code changed}</b>：false = 本来就是这个值，没有实际改动。</li>
 * </ol>
 */
public final class LuckPermsModule {

    /** 一个「用 bridge 干点什么」的调用体。 */
    private interface LpCall<T> {
        T run(LpBridge bridge);
    }

    private final LuckPermsHook hook;

    public LuckPermsModule(LuckPermsHook hook) {
        this.hook = hook;
    }

    public void register(RpcDispatcher dispatcher) {
        dispatcher.register("luckperms.user.get", Capabilities.LUCKPERMS, false,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String uuid = params.uuid("uuid");
                        final String name = params.playerName("name", false);
                        params.done();
                        return invoke(new LpCall<LpUser>() {
                            @Override
                            public LpUser run(LpBridge bridge) {
                                return bridge.getUser(uuid, name);
                            }
                        });
                    }
                });

        dispatcher.register("luckperms.user.setPrimaryGroup", Capabilities.LUCKPERMS, true,
                userGroupHandler("setPrimaryGroup"));
        dispatcher.register("luckperms.user.addGroup", Capabilities.LUCKPERMS, true,
                userGroupHandler("addGroup"));
        dispatcher.register("luckperms.user.removeGroup", Capabilities.LUCKPERMS, true,
                userGroupHandler("removeGroup"));

        dispatcher.register("luckperms.user.setPermission", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String uuid = params.uuid("uuid");
                        final String permission = params.permissionNode("permission", true);
                        final Boolean value = params.bool("value", true);
                        params.done();
                        boolean changed = invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.setPermission(uuid, permission,
                                        value != null && value.booleanValue()));
                            }
                        });
                        return new SmallModels.WriteResult(changed);
                    }
                });

        dispatcher.register("luckperms.user.unsetPermission", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String uuid = params.uuid("uuid");
                        final String permission = params.permissionNode("permission", true);
                        params.done();
                        boolean changed = invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.unsetPermission(uuid, permission));
                            }
                        });
                        return new SmallModels.WriteResult(changed);
                    }
                });

        dispatcher.register("luckperms.user.setMeta", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String uuid = params.uuid("uuid");
                        final String prefix = params.optionalString("prefix", 64);
                        final String suffix = params.optionalString("suffix", 64);
                        params.done();
                        boolean changed = invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.setMeta(uuid, prefix, suffix));
                            }
                        });
                        return new SmallModels.WriteResult(changed);
                    }
                });

        dispatcher.register("luckperms.groups.list", Capabilities.LUCKPERMS, false,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        params.done();
                        return invoke(new LpCall<List<LpGroup>>() {
                            @Override
                            public List<LpGroup> run(LpBridge bridge) {
                                return bridge.groups();
                            }
                        });
                    }
                });

        dispatcher.register("luckperms.group.create", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String name = params.groupName("name", true);
                        params.done();
                        return new SmallModels.WriteResult(invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.createGroup(name));
                            }
                        }));
                    }
                });

        dispatcher.register("luckperms.group.delete", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String name = params.groupName("name", true);
                        params.done();
                        return new SmallModels.WriteResult(invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.deleteGroup(name));
                            }
                        }));
                    }
                });

        dispatcher.register("luckperms.group.setPermission", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String name = params.groupName("name", true);
                        final String permission = params.permissionNode("permission", true);
                        final Boolean value = params.bool("value", true);
                        params.done();
                        return new SmallModels.WriteResult(invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.groupSetPermission(name, permission,
                                        value != null && value.booleanValue()));
                            }
                        }));
                    }
                });

        dispatcher.register("luckperms.group.unsetPermission", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String name = params.groupName("name", true);
                        final String permission = params.permissionNode("permission", true);
                        params.done();
                        return new SmallModels.WriteResult(invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.groupUnsetPermission(name, permission));
                            }
                        }));
                    }
                });

        dispatcher.register("luckperms.group.setParent", Capabilities.LUCKPERMS, true,
                parentHandler(true));
        dispatcher.register("luckperms.group.removeParent", Capabilities.LUCKPERMS, true,
                parentHandler(false));

        dispatcher.register("luckperms.group.setWeight", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String name = params.groupName("name", true);
                        Long weight = params.longValue("weight", true);
                        params.done();
                        if (weight == null || weight.longValue() < -32768L || weight.longValue() > 32767L) {
                            throw Params.invalid("weight", "权重必须在 -32768 ~ 32767 之间");
                        }
                        final int value = weight.intValue();
                        return new SmallModels.WriteResult(invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.groupSetWeight(name, value));
                            }
                        }));
                    }
                });

        dispatcher.register("luckperms.group.setMeta", Capabilities.LUCKPERMS, true,
                new RpcDispatcher.Handler() {
                    @Override
                    public Object handle(Params params) {
                        final String name = params.groupName("name", true);
                        final String prefix = params.optionalString("prefix", 64);
                        final String suffix = params.optionalString("suffix", 64);
                        params.done();
                        return new SmallModels.WriteResult(invokeBoolean(new LpCall<Boolean>() {
                            @Override
                            public Boolean run(LpBridge bridge) {
                                return Boolean.valueOf(bridge.groupSetMeta(name, prefix, suffix));
                            }
                        }));
                    }
                });
    }

    /** {uuid, group} → changed 的三个方法共用一个形状。 */
    private RpcDispatcher.Handler userGroupHandler(final String operation) {
        return new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                final String uuid = params.uuid("uuid");
                final String group = params.groupName("group", true);
                params.done();
                boolean changed = invokeBoolean(new LpCall<Boolean>() {
                    @Override
                    public Boolean run(LpBridge bridge) {
                        if ("setPrimaryGroup".equals(operation)) {
                            return Boolean.valueOf(bridge.setPrimaryGroup(uuid, group));
                        }
                        if ("addGroup".equals(operation)) {
                            return Boolean.valueOf(bridge.addGroup(uuid, group));
                        }
                        return Boolean.valueOf(bridge.removeGroup(uuid, group));
                    }
                });
                return new SmallModels.WriteResult(changed);
            }
        };
    }

    private RpcDispatcher.Handler parentHandler(final boolean add) {
        return new RpcDispatcher.Handler() {
            @Override
            public Object handle(Params params) {
                final String name = params.groupName("name", true);
                final String parent = params.groupName("parent", true);
                params.done();
                return new SmallModels.WriteResult(invokeBoolean(new LpCall<Boolean>() {
                    @Override
                    public Boolean run(LpBridge bridge) {
                        return Boolean.valueOf(bridge.groupSetParent(name, parent, add));
                    }
                }));
            }
        };
    }

    // ── 调用包装 ──────────────────────────────────────────────────────────

    /**
     * 调用 bridge 并把各种失败收敛成协议错误码。
     *
     * <p>{@code LinkageError}（NoSuchMethodError / NoClassDefFoundError / AbstractMethodError）
     * 说明「类在但实际不兼容」—— 这时候回 {@code NO_LUCKPERMS} 并永久降级，
     * 比每次抛一个运维看不懂的链接错误要好。
     */
    private <T> T invoke(LpCall<T> call) {
        LpBridge bridge = hook.require();
        try {
            return call.run(bridge);
        } catch (AgentException e) {
            throw e;
        } catch (LinkageError e) {
            hook.markBroken(e);
            throw new AgentException(ErrorCode.NO_LUCKPERMS,
                    "LuckPerms API 运行期不兼容: " + e.getClass().getSimpleName()
                            + (e.getMessage() == null ? "" : ": " + e.getMessage()));
        } catch (Throwable t) {
            throw new AgentException(ErrorCode.INTERNAL,
                    "LuckPerms 调用失败: " + MainThreadExecutor.describe(t), t);
        }
    }

    private boolean invokeBoolean(LpCall<Boolean> call) {
        Boolean value = invoke(call);
        return value != null && value.booleanValue();
    }
}
