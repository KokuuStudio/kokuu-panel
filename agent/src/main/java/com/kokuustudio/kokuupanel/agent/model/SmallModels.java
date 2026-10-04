package com.kokuustudio.kokuupanel.agent.model;

/** 白名单条目（协议 §5.4）与经济余额（协议 §5.6）。 */
public final class SmallModels {

    private SmallModels() {
    }

    public static final class WhitelistEntry {
        public String uuid;
        public String name;

        public WhitelistEntry(String uuid, String name) {
            this.uuid = uuid;
            this.name = name;
        }
    }

    public static final class EconomyBalance {
        public double balance;
        public String currency;
        public String backend;

        public EconomyBalance(double balance, String currency, String backend) {
            this.balance = balance;
            this.currency = currency;
            this.backend = backend;
        }
    }

    /** 所有写操作的统一返回：changed=false 表示「本来就是这个值」。 */
    public static final class WriteResult {
        public boolean ok = true;
        public boolean changed;

        public WriteResult(boolean changed) {
            this.changed = changed;
        }
    }

    /** 只带 ok 的结果。 */
    public static final class OkResult {
        public boolean ok = true;

        public static OkResult of() {
            return new OkResult();
        }
    }
}
