import mysql from 'mysql2/promise';
import { loadEnv } from './env.js';

const env = loadEnv();

/**
 * 主机固定 127.0.0.1：本机不直连公网，数据库只能经 SSH 隧道抵达。
 * 端口取 DB_PORT（server/.env 里写的是隧道本地端口 13306，
 * 而非服务器上的 3306 —— 两个数字别搞混）。
 */
export const pool = mysql.createPool({
  host: '127.0.0.1',
  port: Number(env.DB_PORT || 13306),
  user: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database: env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 4,
  charset: 'utf8mb4',
  timezone: '+00:00',
});

/** 皮站点自定义的权限位：1=管理员，2=（曾用）超管，4=普通用户。 */
export const PERM_ADMIN = 1;
