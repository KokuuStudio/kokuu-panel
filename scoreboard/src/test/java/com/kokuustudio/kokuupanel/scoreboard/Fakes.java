package com.kokuustudio.kokuupanel.scoreboard;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.logging.Level;
import java.util.logging.Logger;

import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Score;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.ScoreboardManager;
import org.bukkit.scoreboard.Team;

/**
 * 测试用的假对象。
 *
 * <h2>为什么用动态代理而不是 Mockito</h2>
 *
 * 要假的都是 Bukkit 的**接口**（Scoreboard / Team / Player / World …），
 * 用 {@link Proxy} 就够，不必为此再拉一个 mock 框架进来 —— 这个插件的
 * 依赖越少越好（它是要发给服主直接丢进 plugins 的东西）。
 *
 * <p>真正有价值的记录只有一处：{@link FakeBoard#prefixOf} /
 * {@link FakeBoard#suffixOf} —— 也就是**实际传给服务端的字符串**。
 * 那正是 CraftBukkit 会做长度校验的地方，测试要钉的就是它。
 */
final class Fakes {

    private Fakes() {
    }

    /** 测试里不关心日志内容，但也不该把它打到控制台上干扰看结果。 */
    static Logger quietLogger() {
        Logger logger = Logger.getLogger("kokuu-scoreboard-test-" + UUID.randomUUID());
        logger.setUseParentHandlers(false);
        logger.setLevel(Level.OFF);
        return logger;
    }

    /**
     * 一块假的记分板管理器 + 它发出去的那块板子。
     *
     * 记录每个 Team 被设过的 prefix / suffix，以及标题。
     */
    static final class FakeBoard implements InvocationHandler {

        private final Map<String, Team> teams = new HashMap<String, Team>();
        /**
         * 用 IdentityHashMap 而不是 HashMap：key 是**动态代理**，它的
         * {@code hashCode()} 也会走 {@link #invoke}，而那里对不认识的方法返回
         * null —— HashMap 会把它拆箱成 int，于是 NPE。IdentityHashMap 用的是
         * {@code System.identityHashCode}，根本不碰代理的方法。
         */
        private final Map<Team, String> prefix = new IdentityHashMap<Team, String>();
        private final Map<Team, String> suffix = new IdentityHashMap<Team, String>();
        private final List<String> entries = new ArrayList<String>();

        /** 被注销过几次。用来验证「隐藏侧边栏」走的是注销而不是光换板子。 */
        private int objectiveUnregisters;
        private int teamUnregisters;

        private String title = "";

        ScoreboardManager manager() {
            return (ScoreboardManager) Proxy.newProxyInstance(
                    getClass().getClassLoader(), new Class<?>[] { ScoreboardManager.class },
                    new InvocationHandler() {
                        @Override
                        public Object invoke(Object proxy, Method method, Object[] args) {
                            if ("getNewScoreboard".equals(method.getName())) return board();
                            if ("getMainScoreboard".equals(method.getName())) return board();
                            return null;
                        }
                    });
        }

        Scoreboard board() {
            return (Scoreboard) Proxy.newProxyInstance(
                    getClass().getClassLoader(), new Class<?>[] { Scoreboard.class }, this);
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            String name = method.getName();

            if ("registerNewObjective".equals(name)) {
                return Proxy.newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] { Objective.class }, new InvocationHandler() {
                            @Override
                            public Object invoke(Object p, Method m, Object[] a) {
                                if ("setDisplayName".equals(m.getName()) && a != null) {
                                    title = (String) a[0];
                                }
                                if ("unregister".equals(m.getName())) {
                                    objectiveUnregisters++;
                                }
                                if ("getScore".equals(m.getName())) {
                                    return Proxy.newProxyInstance(getClass().getClassLoader(),
                                            new Class<?>[] { Score.class }, new InvocationHandler() {
                                                @Override
                                                public Object invoke(Object sp, Method sm, Object[] sa) {
                                                    return null;
                                                }
                                            });
                                }
                                return null;
                            }
                        });
            }

            if ("registerNewTeam".equals(name)) {
                String teamName = (String) args[0];
                Team team = (Team) Proxy.newProxyInstance(getClass().getClassLoader(),
                        new Class<?>[] { Team.class }, new InvocationHandler() {
                            @Override
                            public Object invoke(Object p, Method m, Object[] a) {
                                String mn = m.getName();
                                if ("setPrefix".equals(mn)) {
                                    prefix.put((Team) p, (String) a[0]);
                                } else if ("setSuffix".equals(mn)) {
                                    suffix.put((Team) p, (String) a[0]);
                                } else if ("addEntry".equals(mn)) {
                                    entries.add((String) a[0]);
                                } else if ("unregister".equals(mn)) {
                                    teamUnregisters++;
                                }
                                return null;
                            }
                        });
                teams.put(teamName, team);
                return team;
            }

            return null;
        }

        /** 第 index 行（Team 名形如 kokuu_line_0）实际被设成的 prefix。 */
        String prefixOf(int index) {
            Team team = teams.get("kokuu_line_" + index);
            return team == null ? null : prefix.get(team);
        }

        String suffixOf(int index) {
            Team team = teams.get("kokuu_line_" + index);
            return team == null ? null : suffix.get(team);
        }

        /** 全部行的 prefix + suffix（用于一次性断言「都不超限」）。 */
        List<String> allParts() {
            List<String> out = new ArrayList<String>();
            for (Team team : teams.values()) {
                out.add(prefix.get(team));
                out.add(suffix.get(team));
            }
            return out;
        }

        String title() {
            return title;
        }

        int teamCount() {
            return teams.size();
        }

        List<String> entries() {
            return entries;
        }

        int objectiveUnregisters() {
            return objectiveUnregisters;
        }

        int teamUnregisters() {
            return teamUnregisters;
        }
    }

    /**
     * 一个假的玩家。
     *
     * 只填 {@link Placeholders} 会读的那几个方法，其余返回 null ——
     * 一旦占位符实现里多读了别的字段，测试会以 NPE 的形式立刻暴露，
     * 而不是悄悄拿到一个错误的值。
     */
    static Player player(final String name, final String worldName) {
        final UUID id = UUID.nameUUIDFromBytes(name.getBytes());
        final World world = (World) Proxy.newProxyInstance(
                Fakes.class.getClassLoader(), new Class<?>[] { World.class },
                new InvocationHandler() {
                    @Override
                    public Object invoke(Object proxy, Method method, Object[] args) {
                        if ("getName".equals(method.getName())) return worldName;
                        return null;
                    }
                });

        return (Player) Proxy.newProxyInstance(Fakes.class.getClassLoader(),
                new Class<?>[] { Player.class }, new InvocationHandler() {
                    @Override
                    public Object invoke(Object proxy, Method method, Object[] args) {
                        String m = method.getName();
                        if ("getName".equals(m)) return name;
                        if ("getDisplayName".equals(m)) return name;
                        if ("getUniqueId".equals(m)) return id;
                        if ("getWorld".equals(m)) return world;
                        if ("getLocation".equals(m)) return new Location(null, 1.9D, 64.0D, -2.7D);
                        if ("getHealth".equals(m)) return 20.0D;
                        if ("getFoodLevel".equals(m)) return 20;
                        if ("getLevel".equals(m)) return 5;
                        if ("getGameMode".equals(m)) return GameMode.SURVIVAL;
                        if ("isOnline".equals(m)) return Boolean.TRUE;
                        if ("hasPermission".equals(m)) {
                            return Boolean.TRUE;
                        }
                        return null;
                    }
                });
    }
}
