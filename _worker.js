// ============================================================
//  Cloudflare Worker —— 彩云天气网页版
//
//  环境变量（Settings → Variables and Secrets）：
//
//    1) CAIYUN_TOKEN  彩云天气 Token（必填，未配置时天气接口会返回错误提示）
//
//    2) 城市配置（两种方式，任选其一，推荐方式 A）
//
//       方式 A（推荐）—— 用一个 JSON 变量装全部城市：
//         CITIES = [
//           {"name":"北京","lng":116.4074,"lat":39.9042},
//           {"name":"深圳","lng":114.0579,"lat":22.5431},
//           {"name":"茂名","lng":110.9426,"lat":21.6753}
//         ]
//
//       方式 B —— 每个城市一个变量，变量名用字母数字，值里带城市名：
//         CITY_BJ = 北京,116.4074,39.9042
//         CITY_SZ = 深圳,114.0579,22.5431
//         也支持：
//           "北京 116.4074 39.9042"（空格分隔）
//           "北京|116.4074|39.9042"
//         兼容旧写法：值只有 "经度,纬度" 时，用变量名当城市名。
//
//    绑定几个城市，网页下拉框里就会出现几个。
// ============================================================

const DEFAULT_LNG   = '110.9426';
const DEFAULT_LAT   = '21.6753';


export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // ---------- 0. 城市列表：/api/cities ----------
      if (url.pathname === '/api/cities') {
        return jsonResponse({ status: 'ok', cities: getCities(env) });
      }

      // ---------- 1. API 代理：/api/weather ----------
      if (url.pathname === '/api/weather') {
        return handleWeather(url, env);
      }

      // ---------- 2. 返回 HTML 页面（把城市列表注入页面） ----------
      // 用函数形式 replace：避免城市名里的 $&、$' 被当成替换模式
      const html = HTML_PAGE.replace('__CITIES_JSON__', function () {
        return safeJson(getCities(env));
      });

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        }
      });
    } catch (err) {
      // 兜底：把真实错误明文返回，方便排查，不再笼统 Error 1101
      return new Response('Worker 内部错误: ' + (err && err.message), {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};

// ============================================================
//  天气接口代理
// ============================================================
async function handleWeather(url, env) {
  const cities = getCities(env);

  let lng = url.searchParams.get('lng');
  let lat = url.searchParams.get('lat');

  // 优先按城市名查询（服务端解析坐标，前端只传名字即可）
  const cityName = url.searchParams.get('city');
  if (cityName) {
    const hit = cities.find(function (c) { return c.name === cityName; });
    if (!hit) {
      return jsonResponse({ status: 'error', error: '未找到城市：' + cityName }, 404);
    }
    lng = String(hit.lng);
    lat = String(hit.lat);
  }

  lng = lng || DEFAULT_LNG;
  lat = lat || DEFAULT_LAT;

  const token = (env && env.CAIYUN_TOKEN) || '';
  if (!token) {
    return jsonResponse({ status: 'error', error: '未配置 CAIYUN_TOKEN 环境变量' }, 500);
  }

  const apiUrl =
    'https://api.caiyunapp.com/v2.6/' + token + '/' + lng + ',' + lat +
    '/weather?alert=true&dailysteps=3&hourlysteps=48';

  try {
    const resp = await fetch(apiUrl, {
      cf: { cacheTtl: 600, cacheEverything: true }
    });
    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600'
      }
    });
  } catch (err) {
    return jsonResponse({ status: 'error', error: err.message }, 502);
  }
}

// ============================================================
//  从 env 中提取城市配置
// ============================================================
function getCities(env) {
  const src = env || {};
  const list = [];

  // ---- 方式 A：CITIES 变量存 JSON 数组 ----
  if (typeof src.CITIES === 'string' && src.CITIES.trim()) {
    try {
      const arr = JSON.parse(src.CITIES);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (!item || item.name == null) continue;
          const lng = Number(item.lng);
          const lat = Number(item.lat);
          if (!validCoord(lng, lat)) continue;
          list.push({ name: String(item.name), lng: lng, lat: lat });
        }
      }
    } catch (e) { /* 解析失败时退回方式 B */ }

    if (list.length) return sortCities(list);
  }

  // ---- 方式 B：扫描其它变量，从“值”里解析城市名 + 坐标 ----
  for (const key of Object.keys(src)) {
    if (key === 'CITIES' || key === 'CAIYUN_TOKEN') continue;
    const city = parseCityEntry(key, src[key]);
    if (city) list.push(city);
  }

  return sortCities(list);
}

// 解析 "北京,116.4074,39.9042" / "北京 116.4074 39.9042"
// 或只有坐标 "116.4074,39.9042"（此时用变量名当城市名）
function parseCityEntry(varName, rawValue) {
  if (typeof rawValue !== 'string') return null;

  const parts = rawValue.trim().split(/[\s,，;；、|]+/).filter(Boolean);
  if (parts.length < 2) return null;

  // 3 段及以上：最后两段当作坐标，前面的都当城市名
  if (parts.length >= 3) {
    const lng = Number(parts[parts.length - 2]);
    const lat = Number(parts[parts.length - 1]);
    if (validCoord(lng, lat)) {
      const name = parts.slice(0, parts.length - 2).join(' ').trim() || varName;
      return { name: name, lng: lng, lat: lat };
    }
  }

  // 2 段：全是坐标，变量名做城市名
  if (parts.length === 2) {
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (validCoord(lng, lat)) {
      return { name: varName, lng: lng, lat: lat };
    }
  }

  return null;
}

function validCoord(lng, lat) {
  return isFinite(lng) && isFinite(lat) &&
         lng >= -180 && lng <= 180 &&
         lat >= -90  && lat <= 90;
}

function sortCities(list) {
  // 修复 Error 1101：原来的 localeCompare 依赖 ICU 地区数据，
  // Cloudflare Workers 运行时缺少对应数据时会抛
  // RangeError: Incorrect locale information provided，
  // 导致所有路径（含 /api/cities）都返回 500。
  // 改为纯代码点比较，对中文城市名排序足够稳定。
  return list.sort(function (a, b) {
    const x = String(a.name), y = String(b.name);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

// 把对象安全地嵌进 <script type="application/json"> 里
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ============================================================
//  前端页面（HTML + CSS + JS 全部内嵌）
// ============================================================
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1220">
<title>天气预报</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background-color:#0b1220;
  background-image:radial-gradient(1200px 620px at 12% -12%,#1c3760 0%,transparent 62%),radial-gradient(900px 520px at 108% 6%,#123048 0%,transparent 58%);
  background-attachment:fixed;
  color:#e8eef7;
  min-height:100vh;
  padding:16px 14px 34px;
  font-size:14px;
  -webkit-font-smoothing:antialiased;
}
.app{max-width:540px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
#app{display:flex;flex-direction:column;gap:12px}
.card{
  background:rgba(255,255,255,.055);
  border:1px solid rgba(255,255,255,.08);
  border-radius:18px;
  padding:16px;
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
}
.skeleton{text-align:center;padding:60px 16px;color:#7f95b3;line-height:1.9}
.card-title{font-size:11px;letter-spacing:.1em;color:#7f95b3;font-weight:600;margin-bottom:12px}

/* ---------- 城市选择栏 ---------- */
.city-bar{display:flex;align-items:center;gap:10px;padding:10px 12px}
.city-bar::before{content:"📍";font-size:15px;line-height:1;flex:0 0 auto}
select.city-select{
  flex:1 1 auto;min-width:0;
  appearance:none;-webkit-appearance:none;-moz-appearance:none;
  font-family:inherit;font-size:14px;font-weight:600;color:#e8eef7;
  background-color:rgba(255,255,255,.07);
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath fill='none' stroke='%237f95b3' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' d='M1 1.5 6 6.5 11 1.5'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;background-size:12px 8px;
  border:1px solid rgba(255,255,255,.1);border-radius:12px;
  padding:10px 34px 10px 12px;
  outline:none;cursor:pointer;
  transition:border-color .18s,background-color .18s;
}
select.city-select:hover{background-color:rgba(255,255,255,.1)}
select.city-select:focus{border-color:rgba(95,168,245,.65);background-color:rgba(255,255,255,.1)}
select.city-select option{background:#0f1728;color:#e8eef7}

.now{padding:18px;position:relative;overflow:hidden}
.now::before{content:"";position:absolute;top:-100px;right:-70px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(79,195,247,.22),transparent 70%);pointer-events:none}
.now-head{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:11.5px;color:#8fa3bf;position:relative;z-index:1}
.now-head span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.now-head span:last-child{flex:0 0 auto}
.now-main{display:flex;justify-content:space-between;align-items:center;margin-top:12px;position:relative;z-index:1}
.temp-big{font-size:62px;line-height:1;font-weight:200;letter-spacing:-.045em}
.temp-big span{font-size:28px;font-weight:300;color:#9fb6d4;vertical-align:top;line-height:1.6}
.now-desc{font-size:13.5px;color:#b9cbe2;margin-top:8px}
.now-icon{font-size:58px;line-height:1;filter:drop-shadow(0 8px 18px rgba(0,0,0,.35))}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;position:relative;z-index:1}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.08);color:#c8d8ea}
.chip i{width:7px;height:7px;border-radius:50%;display:inline-block}

.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.metric{background:rgba(255,255,255,.04);border-radius:13px;padding:11px 6px;text-align:center}
.metric .m-label{font-size:11px;color:#7f95b3}
.metric .m-value{font-size:15px;font-weight:600;margin-top:5px;letter-spacing:-.01em}
.metric .m-value small{font-size:10.5px;font-weight:400;color:#8fa3bf;margin-left:1px}

.hourly-scroll{overflow-x:auto;overflow-y:hidden;margin:0 -16px;padding:0 16px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.hourly-scroll::-webkit-scrollbar{display:none}
.hourly-inner{position:relative;height:174px;width:max-content}
.hourly-svg{position:absolute;left:0;top:0;pointer-events:none;z-index:0}
.hour-row{display:flex;position:relative;z-index:1;height:174px}
.hour{position:relative;width:58px;flex:0 0 58px;height:174px}
.h-time{position:absolute;top:0;left:0;right:0;text-align:center;font-size:11px;color:#7f95b3;white-space:nowrap}
.h-icon{position:absolute;top:24px;left:0;right:0;text-align:center;font-size:19px;line-height:1}
.h-temp{position:absolute;left:0;right:0;text-align:center;font-size:13px;font-weight:600;line-height:16px;font-variant-numeric:tabular-nums}
.h-pop{position:absolute;bottom:4px;left:0;right:0;text-align:center;font-size:10px;color:#5fa8f5}

.day{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.055)}
.day:last-child{border-bottom:none;padding-bottom:2px}
.day-date{width:72px;font-size:12.5px;color:#c8d8ea;white-space:nowrap}
.day-icon{font-size:21px;width:28px;text-align:center;line-height:1}
.day-desc{flex:1;font-size:12.5px;color:#8fa3bf}
.day-temp{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.day-temp .lo{color:#8fa3bf;font-weight:400;margin-left:7px}

.life{display:grid;grid-template-columns:repeat(auto-fill,minmax(94px,1fr));gap:9px}
.life-item{background:rgba(255,255,255,.04);border-radius:13px;padding:11px 6px;text-align:center}
.life-item .li-name{font-size:11px;color:#7f95b3}
.life-item .li-desc{font-size:13px;font-weight:600;margin-top:6px;color:#dce8f5}

.alert-card{background:linear-gradient(135deg,rgba(248,113,113,.2),rgba(248,113,113,.07));border:1px solid rgba(248,113,113,.32);border-radius:18px;padding:14px 16px}
.alert-card h4{font-size:13.5px;color:#fecaca;margin-bottom:6px;font-weight:600}
.alert-card p{font-size:12px;color:#e9c0c0;line-height:1.65}

.foot{text-align:center;font-size:11px;color:#556a85;padding:6px 0 4px}
</style>
</head>
<body>
<div class="app">
  <div class="card city-bar" id="city-bar">
    <select class="city-select" id="city-select" aria-label="选择城市"></select>
  </div>
  <div id="app"><div class="card skeleton">正在获取天气数据…</div></div>
</div>

<!-- 由 Worker 注入的城市列表 -->
<script id="boot-cities" type="application/json">__CITIES_JSON__</script>

<script>
(function(){
'use strict';

var ICONS = {
  CLEAR_DAY:'☀️', CLEAR_NIGHT:'🌙',
  PARTLY_CLOUDY_DAY:'⛅', PARTLY_CLOUDY_NIGHT:'☁️',
  CLOUDY:'☁️',
  LIGHT_HAZE:'🌫️', MODERATE_HAZE:'🌫️', HEAVY_HAZE:'🌫️',
  LIGHT_RAIN:'🌦️', MODERATE_RAIN:'🌧️', HEAVY_RAIN:'🌧️', STORM_RAIN:'⛈️',
  FOG:'🌫️',
  LIGHT_SNOW:'🌨️', MODERATE_SNOW:'🌨️', HEAVY_SNOW:'❄️', STORM_SNOW:'❄️',
  DUST:'🌪️', SAND:'🌪️', WIND:'💨'
};
var DESCS = {
  CLEAR_DAY:'晴', CLEAR_NIGHT:'晴',
  PARTLY_CLOUDY_DAY:'多云', PARTLY_CLOUDY_NIGHT:'多云',
  CLOUDY:'阴',
  LIGHT_HAZE:'轻度霾', MODERATE_HAZE:'中度霾', HEAVY_HAZE:'重度霾',
  LIGHT_RAIN:'小雨', MODERATE_RAIN:'中雨', HEAVY_RAIN:'大雨', STORM_RAIN:'暴雨',
  FOG:'雾',
  LIGHT_SNOW:'小雪', MODERATE_SNOW:'中雪', HEAVY_SNOW:'大雪', STORM_SNOW:'暴雪',
  DUST:'浮尘', SAND:'沙尘', WIND:'大风'
};
var WEEK = ['周日','周一','周二','周三','周四','周五','周六'];
var DIRS = ['北','东北','东','东南','南','西南','西','西北'];

var DEFAULT_LNG = 110.9426;
var DEFAULT_LAT = 21.6753;
var STORAGE_KEY = 'caiyun_city';

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function pad2(n){ return (n < 10 ? '0' : '') + n; }

function aqiColor(v){
  if(v <= 50)  return '#4ade80';
  if(v <= 100) return '#facc15';
  if(v <= 150) return '#fb923c';
  if(v <= 200) return '#f87171';
  if(v <= 300) return '#c084fc';
  return '#fb7185';
}

function tempColor(t){
  var x = (t + 10) / 50;
  if(x < 0) x = 0;
  if(x > 1) x = 1;
  var r = Math.round(96 + x * 143);
  var g = Math.round(165 - x * 95);
  var b = Math.round(250 - x * 180);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function toMs(t){
  if(t == null) return NaN;
  var n = typeof t === 'number' ? t : Number(t);
  if(!isFinite(n)) return NaN;
  // 小于 1e12 视为秒级时间戳（彩云用的是秒），否则视为毫秒
  return n < 1e12 ? n * 1000 : n;
}

function hourLabel(ts, tz){
  var ms = toMs(ts);
  var d  = new Date(ms);
  if(isNaN(d.getTime())) return '--时';

  var h = null;
  try{
    var s = new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hour12:false,timeZone:tz}).format(d);
    h = parseInt(s, 10);
  }catch(e){}
  if(h === null || isNaN(h)) h = d.getHours();
  if(!isFinite(h)) return '--时';
  if(h === 24) h = 0;
  return h + '时';
}

function fmtClock(ts, tz){
  var d = new Date(toMs(ts));
  if(isNaN(d.getTime())) return '--:--';
  try{
    return new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:tz}).format(d);
  }catch(e){
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
}

function dayLabel(dateStr, idx){
  if(idx === 0) return '今天';
  if(idx === 1) return '明天';
  if(idx === 2) return '后天';
  var p = String(dateStr).split('-');
  if(p.length === 3){
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + WEEK[d.getUTCDay()];
  }
  return dateStr;
}

function dirName(deg){
  var i = Math.round((deg || 0) / 45) % 8;
  if(i < 0) i += 8;
  return DIRS[i];
}

// ============================================================
//  城市列表 & 当前选中城市
// ============================================================
var CITY_LIST = [];
try{
  var bootNode = document.getElementById('boot-cities');
  var parsed = JSON.parse(bootNode.textContent || '[]');
  if(Array.isArray(parsed)) CITY_LIST = parsed;
}catch(e){ CITY_LIST = []; }

function findCity(name){
  for(var i = 0; i < CITY_LIST.length; i++){
    if(CITY_LIST[i].name === name) return CITY_LIST[i];
  }
  return null;
}

function readSaved(){
  try{ return localStorage.getItem(STORAGE_KEY); }catch(e){ return null; }
}
function writeSaved(name){
  try{ localStorage.setItem(STORAGE_KEY, name); }catch(e){}
}

// 解析初始城市：URL ?city= > URL ?lng=&lat= > localStorage > 第一个城市 > 内置默认
var selected = (function initSelection(){
  var params = new URLSearchParams(location.search);

  var qCity = params.get('city');
  if(qCity){
    var c = findCity(qCity);
    if(c) return c;
  }

  var qLng = parseFloat(params.get('lng'));
  var qLat = parseFloat(params.get('lat'));
  if(isFinite(qLng) && isFinite(qLat)){
    for(var i = 0; i < CITY_LIST.length; i++){
      var ci = CITY_LIST[i];
      if(Math.abs(ci.lng - qLng) < 1e-6 && Math.abs(ci.lat - qLat) < 1e-6) return ci;
    }
    return { name: '', lng: qLng, lat: qLat };
  }

  var saved = readSaved();
  if(saved){
    var cs = findCity(saved);
    if(cs) return cs;
  }

  if(CITY_LIST.length) return CITY_LIST[0];
  return { name: '', lng: DEFAULT_LNG, lat: DEFAULT_LAT };
})();

function syncUrl(){
  var u = new URL(location.href);
  if(selected.name){
    u.searchParams.set('city', selected.name);
    u.searchParams.delete('lng');
    u.searchParams.delete('lat');
  }else{
    u.searchParams.set('lng', selected.lng);
    u.searchParams.set('lat', selected.lat);
    u.searchParams.delete('city');
  }
  history.replaceState(null, '', u.pathname + u.search);
}

// ============================================================
//  城市选择器
// ============================================================
function buildPicker(){
  var bar = document.getElementById('city-bar');
  var sel = document.getElementById('city-select');

  if(!CITY_LIST.length){
    bar.style.display = 'none';
    return;
  }

  var html = '';
  for(var i = 0; i < CITY_LIST.length; i++){
    var name = CITY_LIST[i].name;
    html += '<option value="' + esc(name) + '">' + esc(name) + '</option>';
  }
  if(!selected.name){
    html = '<option value="__current__">当前位置</option>' + html;
  }
  sel.innerHTML = html;
  sel.value = selected.name || '__current__';

  sel.addEventListener('change', function(){
    var name = sel.value;
    if(name === '__current__') return;
    var c = findCity(name);
    if(!c) return;
    selected = c;
    writeSaved(c.name);
    syncUrl();
    load();
  });
}

// ============================================================
//  拉取天气
// ============================================================
function load(){
  var app = document.getElementById('app');
  app.innerHTML = '<div class="card skeleton">正在获取天气数据…</div>';

  var query = selected.name
    ? 'city=' + encodeURIComponent(selected.name)
    : 'lng=' + encodeURIComponent(selected.lng) + '&lat=' + encodeURIComponent(selected.lat);

  fetch('/api/weather?' + query)
    .then(function(res){ return res.json(); })
    .then(function(data){
      if(!data || data.status !== 'ok'){
        throw new Error((data && (data.error || data.message)) || '接口返回异常');
      }
      render(data);
    })
    .catch(function(err){
      app.innerHTML =
        '<div class="card skeleton">😕 天气数据加载失败<br>' +
        '<span style="font-size:12px;color:#5b6f8a">' + esc(err.message) + '</span><br><br>' +
        '<a href="javascript:location.reload()" style="color:#5fa8f5;text-decoration:none;font-size:13px">点击重试</a>' +
        '</div>';
    });
}

// ============================================================
//  渲染
// ============================================================
function render(data){
  var r = data.result || {};
  var rt = r.realtime || {};
  var hourly = r.hourly || {};
  var daily = r.daily || {};
  var tz = data.timezone || 'Asia/Shanghai';
  var loc = data.location || [];
  var lng = loc[0] != null ? loc[0] : selected.lng;
  var lat = loc[1] != null ? loc[1] : selected.lat;

  var out = [];

  var alerts = (r.alert && r.alert.content) || [];
  for(var i = 0; i < alerts.length; i++){
    out.push(
      '<div class="alert-card">' +
        '<h4>⚠ ' + esc(alerts[i].title || '气象预警') + '</h4>' +
        '<p>' + esc(alerts[i].description || '') + '</p>' +
      '</div>'
    );
  }

  var sky    = rt.skycon || 'CLOUDY';
  var temp   = rt.temperature != null ? Math.round(rt.temperature) : '--';
  var feels  = rt.apparent_temperature != null ? Math.round(rt.apparent_temperature) : '--';
  var updStr = fmtClock(data.server_time || Math.floor(Date.now() / 1000), tz);
  var air    = rt.air_quality || {};
  var aqi    = air.aqi ? air.aqi.chn : null;
  var aqiDsc = air.description ? air.description.chn : '';

  var place = (selected.name ? esc(selected.name) + ' · ' : '') +
              Number(lng).toFixed(4) + ', ' + Number(lat).toFixed(4);

  var chips = '';
  if(aqi != null){
    chips += '<span class="chip"><i style="background:' + aqiColor(aqi) + '"></i>空气 ' + aqi + ' · ' + esc(aqiDsc) + '</span>';
  }
  if(rt.humidity != null){
    chips += '<span class="chip">💧 湿度 ' + Math.round(rt.humidity * 100) + '%</span>';
  }
  if(rt.wind){
    chips += '<span class="chip">🌬 ' + dirName(rt.wind.direction) + '风 ' + rt.wind.speed + ' km/h</span>';
  }

  out.push(
    '<div class="card now">' +
      '<div class="now-head">' +
        '<span>📍 ' + place + '</span>' +
        '<span>' + updStr + ' 更新</span>' +
      '</div>' +
      '<div class="now-main">' +
        '<div>' +
          '<div class="temp-big">' + temp + '<span>°</span></div>' +
          '<div class="now-desc">' + (DESCS[sky] || sky) + ' · 体感 ' + feels + '°</div>' +
        '</div>' +
        '<div class="now-icon">' + (ICONS[sky] || '☁️') + '</div>' +
      '</div>' +
      '<div class="chips">' + chips + '</div>' +
    '</div>'
  );

  var prRaw = (rt.precipitation && rt.precipitation.local) ? rt.precipitation.local.intensity : 0;
  var prVal = (prRaw && prRaw > 0) ? prRaw.toFixed(1) : '0';

  var metrics = [
    ['湿度',   rt.humidity != null ? Math.round(rt.humidity * 100) : '--', '%'],
    ['风速',   rt.wind ? rt.wind.speed : '--', 'km/h'],
    ['气压',   rt.pressure != null ? Math.round(rt.pressure / 100) : '--', 'hPa'],
    ['能见度', rt.visibility != null ? rt.visibility : '--', 'km'],
    ['云量',   rt.cloudrate != null ? Math.round(rt.cloudrate * 100) : '--', '%'],
    ['降水',   prVal, 'mm/h']
  ];

  var metricsHtml = '<div class="card"><div class="card-title">实时指标</div><div class="metrics">';
  for(var i = 0; i < metrics.length; i++){
    metricsHtml += '<div class="metric">' +
      '<div class="m-label">' + metrics[i][0] + '</div>' +
      '<div class="m-value">' + metrics[i][1] + '<small>' + metrics[i][2] + '</small></div>' +
    '</div>';
  }
  metricsHtml += '</div></div>';
  out.push(metricsHtml);

  var hT = hourly.temperature || [];
  var hS = hourly.skycon || [];
  var hP = hourly.precipitation || [];

  if(hT.length){
    var tMin = Infinity, tMax = -Infinity;
    for(var i = 0; i < hT.length; i++){
      var v = hT[i].value;
      if(v < tMin) tMin = v;
      if(v > tMax) tMax = v;
    }
    var span = (tMax - tMin) || 1;
    var svgW = hT.length * 58;

    var pts = [];
    for(var i = 0; i < hT.length; i++){
      var y = 58 + (1 - (hT[i].value - tMin) / span) * 60 + 8;
      pts.push((i * 58 + 29) + ',' + y.toFixed(1));
    }

    var cells = '';
    // 基准时间：优先用接口返回的 server_time，否则用当前时间
    var baseMs = (data.server_time ? data.server_time * 1000 : Date.now());

    for(var i = 0; i < hT.length; i++){
    var tv  = hT[i].value;
    var top = 58 + (1 - (tv - tMin) / span) * 60;
    var sk  = hS[i] ? hS[i].value : 'CLOUDY';
    var pop = (hP[i] && hP[i].probability != null) ? hP[i].probability : 0;
    if(pop <= 1) pop = pop * 100;
    pop = Math.round(pop);

    // 优先用数据自带的 time；无效则按基准时间 + i 小时推算
    var hourMs = toMs(hT[i].time);
    if(!isFinite(hourMs)) hourMs = baseMs + i * 3600 * 1000;

    cells += '<div class="hour">' +
      '<div class="h-time">' + hourLabel(hourMs, tz) + '</div>' +
      '<div class="h-icon">' + (ICONS[sk] || '☁️') + '</div>' +
      '<div class="h-temp" style="top:' + top.toFixed(1) + 'px;color:' + tempColor(tv) + '">' +
        Math.round(tv) + '°</div>' +
      (pop >= 20 ? '<div class="h-pop">' + pop + '%</div>' : '') +
      '</div>';
    }

    out.push(
      '<div class="card">' +
        '<div class="card-title">未来 ' + hT.length + ' 小时</div>' +
        '<div class="hourly-scroll">' +
          '<div class="hourly-inner">' +
            '<svg class="hourly-svg" width="' + svgW + '" height="174" viewBox="0 0 ' + svgW + ' 174">' +
              '<polyline fill="none" stroke="rgba(110,168,254,.42)" stroke-width="2" ' +
                'stroke-linecap="round" stroke-linejoin="round" points="' + pts.join(' ') + '"/>' +
            '</svg>' +
            '<div class="hour-row">' + cells + '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  var dT = daily.temperature || [];
  var dS = daily.skycon || [];

  if(dT.length){
    var rows = '';
    for(var i = 0; i < dT.length; i++){
      var sk = dS[i] ? dS[i].value : 'CLOUDY';
      rows += '<div class="day">' +
        '<div class="day-date">' + dayLabel(dT[i].date, i) + '</div>' +
        '<div class="day-icon">' + (ICONS[sk] || '☁️') + '</div>' +
        '<div class="day-desc">' + (DESCS[sk] || '') + '</div>' +
        '<div class="day-temp">' + Math.round(dT[i].max) + '°' +
          '<span class="lo">' + Math.round(dT[i].min) + '°</span></div>' +
      '</div>';
    }
    out.push(
      '<div class="card">' +
        '<div class="card-title">未来 ' + dT.length + ' 天</div>' +
        rows +
      '</div>'
    );
  }

  var li = daily.life_index || {};
  var LIFE = [
    ['ultraviolet', '紫外线'],
    ['dressing',    '穿衣'],
    ['comfort',     '舒适度'],
    ['carWashing',  '洗车'],
    ['coldRisk',    '感冒']
  ];
  var lifeItems = '';
  for(var i = 0; i < LIFE.length; i++){
    var arr = li[LIFE[i][0]];
    if(!arr || !arr.length) continue;
    lifeItems += '<div class="life-item">' +
      '<div class="li-name">' + LIFE[i][1] + '</div>' +
      '<div class="li-desc">' + esc(arr[0].desc || arr[0].index || '') + '</div>' +
    '</div>';
  }
  if(lifeItems){
    out.push(
      '<div class="card">' +
        '<div class="card-title">今日生活指数</div>' +
        '<div class="life">' + lifeItems + '</div>' +
      '</div>'
    );
  }

  out.push('<div class="foot">数据来源：彩云天气</div>');

  document.getElementById('app').innerHTML = out.join('');
}

// ============================================================
//  启动
// ============================================================
buildPicker();
syncUrl();
load();

})();
</script>
</body>
</html>`;
