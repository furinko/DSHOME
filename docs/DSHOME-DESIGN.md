# DSHOME 瀹㈡埛绔璁℃柟妗堬紙楠ㄦ灦鐗堬級

> 鐗堟湰锛歷1.0 锝?鐘舵€侊細宸蹭笌闇€姹傛柟纭锛屽緟瀹炴柦 锝?鐩爣璇昏€咃細瀹炴柦鑰咃紙DeepSeek + dsh 浠ｇ悊锛変笌闇€姹傛柟鏈汉

---

## 1. 椤圭洰瀹氫綅

**DSHOME** 鏄竴娆鹃潰鍚戜釜浜轰娇鐢ㄧ殑 DeepSeek Harness 妗岄潰瀹㈡埛绔細

- **褰㈡€?*锛氭闈㈠３锛圖esktop Shell锛? 鑷湁瀹㈡埛绔?bundle锛堣矾寰勪箼锛?- **鍘熷垯**锛氶鏋跺厛琛岋紝鑳藉姏鎻掍欢鍖栤€斺€擬VP 鍙氦浠?鑳借窇閫氱殑楠ㄦ灦 + 棰勭暀鎵╁睍鐐?锛屽悗缁墍鏈夊姛鑳斤紙涓婚銆佸懡浠ら潰鏉裤€佷細璇濈疆椤躲€侀檮鍔犻潰鏉裤€佽繙绋嬭闂級涓€寰嬩互鎻掍欢褰㈠紡鐢熼暱锛屼笉鏀归鏋躲€?- **寮€鍙戞柟寮?*锛氫娇鐢?DeepSeek + dsh锛圓I 浠ｇ悊锛夊疄鏂斤紝鏈柟妗堢簿纭埌鏂囦欢缁撴瀯銆佽ˉ涓佽銆佷緷璧栨竻鍗曚笌楠屾敹鏍囧噯锛屼唬鐞嗗彲鐩存帴鎵ц銆?
## 2. 宸茬‘璁ゅ喅绛?
| 鍐崇瓥椤?| 瀹氭 |
|---|---|
| 椤圭洰鍚?/ npm 鍖呭悕 | **DSHOME** / `dshome`锛坣pm 鍚嶅凡楠岃瘉涓虹┖闂诧級 |
| profile 鍚嶄笌鍚姩鍛戒护 | `dsh --profile dshome` |
| 瀹㈡埛绔矾寰?| 璺緞涔欙細鐙珛 profile bundle锛屽畼鏂?client 妯″潡鎵撳簳 + 鑷湁瑕嗙洊灞?|
| 澶栧３褰㈡€?| 钖勫３锛氭闈㈢獥鍙?+ 鎵樼洏 + 鍗曞疄渚?+ 鍚庣鐩戞祴锛堝弬鑰?dsh-clean-desktop-shell / dsh-plugin-desktop 鍏煎妯″紡锛?|
| MVP 鑼冨洿 | 楠ㄦ灦璺戦€氾紙A 鐙珛鍏ュ彛 + B 钖勫３灞?+ 鎵╁睍鐐归鐣欙級锛岄浂澶氫綑鍔熻兘 |
| 鐣岄潰璇█ | 涓枃 |
| 棣栧彂骞冲彴 | Windows x64锛沵acOS 浜屾湡 |
| 鐩爣鐢ㄦ埛 | 涓汉鑷敤 |
| 鎶€鏈爤 | Node 24 + TypeScript锛堥鏋跺彲鍏堢函 JS锛? Cordis 4 + DSH 鏍稿績鍖咃紙閽夋 `0.1.1-rc.2`锛? Electron锛堝３杩愯鏃讹級 |
| 涓婃父绛栫暐 | 璺熼殢 DeepSeek Harness 瀹樻柟 `@deepseek-ai/*` 鍖咃紙鍚?DSH Desktop 鐨?pin 绛栫暐锛?|

## 3. 鑳屾櫙锛欴SH "瀹㈡埛绔?鐨勬湰璐紙宸叉牳瀹炵殑浜嬪疄锛?
浠ヤ笅鏈哄埗鏉ヨ嚜瀵规湰鏈?DSH Desktop 2.0.3锛坄dsh-plugin-desktop`锛夋墦鍖呬骇鐗╃殑閫嗗悜鏍稿疄锛屽潎涓虹湡瀹炲瓧娈典笌琛屼负锛?
1. **Profile = 涓€涓?Cordis 搴旂敤**銆俙dsh --profile <name>` 鍚姩涓€涓嫭绔?Cordis 杩愯鏃讹紙Host 杩涚▼锛夛紝鐢卞嚑灞?**bundle 琛ヤ竵锛坈ordis.patch.yml锛?* 缁勮锛?   - 绗?1 灞傦細`@deepseek-ai/dsh-base`锛?every profile's first patch layer"锛?7 涓緷璧栵紝鎻掑叆鏍稿績琛岋細timer / hmr / llm / session / typert / 鈥︼級
   - 绗?2 灞傦細妯″紡 bundle鈥斺€旀祻瑙堝櫒闈?`@deepseek-ai/dsh-web-app`锛堝湪 dsh-base 涔嬩笂鍙犲姞 webserver / web-runtime / 瀹樻柟 client roster锛夛紱鏃犲ご `@deepseek-ai/dsh-headless`
   - 绗?3 灞傦細profile 鑷繁鐨?`cordis.patch.yml`
   - 绗?4 灞傦細CLI `--patch` 瑕嗙洊灞?   - **琛岃涔?*锛氬悓涓€ `id` 鐨勫悗灞傝ˉ涓?*鏁翠綋鏇挎崲**璇ヨ config锛堜笉鍚堝苟锛夛紱`- insert:` 杩藉姞鏂拌锛沗disabled: true` 鍋滅敤鍩哄骇琛岋紱`name: pkg` 鎴?`name: pkg/subpath` 瀹氫綅鎻掍欢銆?2. **瀹㈡埛绔?UI = 涓€寮?client roster**銆俙cordis.patch.yml` 涓互 `insert` 鎸傝浇鐨?`dsh-client-*` 琛屾棦鏄?host 鎻掍欢鑺傜偣锛屼篃鏄?**browser roster**锛氱敱 `dsh-client-modules` 鐨?node 鍗婇儴鎵弿鏁存５渚濊禆鏍戯紝缁勮鎴?`window.__DSH_BOOT__`锛涙祻瑙堝櫒绔?`dsh-client-runtime` + `dsh-cordis-client-runner` 鍦ㄩ〉闈㈤噷鍚姩娴忚鍣ㄧ Cordis銆?3. **瀹樻柟 web roster 鍏ㄩ儴琛?*锛堟潵鑷?`dsh-web-app/cordis.patch.yml`锛屽潎鍙寜闇€瑁佸壀/鎻掓嫈锛夛細
   `modules`銆乣connection`銆乣api-remotes`銆乣client-runtime`銆乣cordis-client-runner`銆乣ui-theme`銆乣locale`銆乣ui-layout`銆乣ui-renderer`銆乣ui-sidebar`銆乣ui-settings`銆乣ui-settings-general`銆乣ui-settings-models`銆乣ui-settings-plugin-inventory`銆乣ui-conversation`銆乣ui-brand-official`銆乣ui-attachment`銆乣ui-tool`銆乣ui-cordis`銆乣ui-workflow-run`銆乣ui-deliverables`銆乣ui-workspace`銆乣ui-input-trigger`銆乣ui-commands`銆乣ui-skill`銆乣ui-subagent`銆乣ui-reference`銆乣ui-jobs`銆乣ui-goal`銆乣ui-message-feedback`銆乣ui-model-selection`銆乣ui-permission`銆乣ui-agent-preset`銆乣ui-settings-plugins`銆乣ui-plan`銆乣ui-user-questions`銆乣ui-trajectory`
4. **琛ヤ竵瑕嗙洊妯℃澘锛堟闈㈠吋瀹规ā寮忥級** = `dsh-plugin-desktop/cordis.patch.yml`锛氬湪 web bundle 涔嬩笂 insert `desktop-shell / desktop-terminal / desktop-notifications / desktop-pnpm / desktop-profiles / desktop-updates`锛屽苟瑕嗙洊 `web-runtime` 琛?`openBrowser: false / printUrl: false / surfaceContext: true / trustedHosts: []`銆?5. **鎻掍欢褰㈡€佽杽澹冲厛渚?* = `dsh-clean-desktop-shell`锛圛cather锛夛細鎸傚湪鐜版湁 profile 涓婏紝鎻愪緵绯荤粺鎵樼洏銆佸崟瀹炰緥銆佸悗绔椿鎬х洃娴?+ 绂荤嚎椤?+ 鑷姩閲嶈繛銆佹墭鐩樹竴閿惎鍋滃悗绔€佹闈㈠揩鎹锋柟寮忋€佹鏌ユ洿鏂帮紱Electron 杩愯鏃堕娆¤仈缃戣嚜鍔ㄥ噯澶囷紙绾?1鈥? 鍒嗛挓锛夛紝涓嶅仛浠讳綍瑙嗚鏀归€犮€?
## 4. 鎬讳綋鏋舵瀯

```
dshome锛坣pm 鍖咃紝profile bundle锛?鈹溾攢鈹€ cordis.patch.yml           # profile 绗?3 灞傝ˉ涓侊細缁勮涓嬮潰 4 涓缁?鈹溾攢鈹€ dshome/shell       (host)  # Electron 钖勫３锛氱獥鍙?鎵樼洏/鍗曞疄渚?鍚庣鐩戞祴/閫氱煡妗?鈹溾攢鈹€ dshome/core        (host)  # DSHOME 鏈嶅姟锛歝ommands / panels 娉ㄥ唽琛紙鏈潵鎻掍欢鐨勬墿灞曠偣锛?鈹溾攢鈹€ dshome/client-core (client)# 娴忚鍣ㄧ鏍稿績锛氭彃妲戒笌鍛戒护娉ㄥ唽锛屼笌 host 鏈嶅姟瀵归€?鈹斺攢鈹€ dshome/theme       (client)# DSHOME 涓婚锛堣鐩栧畼鏂?ui-theme锛?        鈻?        鈹?渚濊禆/琛屽紩鐢?  @deepseek-ai/dsh-web-app锛堢 2 灞傦細webserver / web-runtime / 瀹樻柟 client roster锛?        鈻?  @deepseek-ai/dsh-base 锛堢 1 灞傦細host 鏍稿績琛岋級
```

鍚姩閾捐矾锛歚dsh --profile dshome` 鈫?composeProfile 渚濆簭搴旂敤 `dsh-base 鈫?dsh-web-app 鈫?dshome` 涓夊眰琛ヤ竵 鈫?host 鍚姩锛坵ebserver 缁戝畾涓撳睘绔彛锛夆啋 `dshome/shell` 鎷夎捣 Electron 绐楀彛鍔犺浇 `http://127.0.0.1:<port>` 鈫?娴忚鍣ㄧ Cordis 渚?`__DSH_BOOT__` roster 鍚姩瀹樻柟 UI + DSHOME 瑕嗙洊灞傘€?
**鍙栬垗璇存槑**锛氶鏋堕樁娈靛鐢ㄥ畼鏂?web bundle 浣滀负娴忚鍣ㄩ潰锛堝吋瀹规ā寮忥級锛岀悊鐢憋細
- 瀹樻柟瀵硅瘽/杈撳叆/瀹℃壒/璁剧疆鑳藉姏闆舵垚鏈户鎵匡紝绗﹀悎"楠ㄦ灦璺戦€?鐩爣锛?- dshome 灞傚彲闅忔椂瑕嗙洊浠绘剰琛岀殑 config銆佸仠鐢ㄥ畼鏂硅銆佹彃鍏ヨ嚜鏈?client 鎻掍欢鈥斺€斿悗缁?闀垮嚭鑷繁鐣岄潰"鐨勮矾寰勬槸鐜版垚鐨勶紙鏇挎崲 roster銆佹彃妲芥敞鍐屻€佽嚜缁樼粍浠跺潎鍙€愭鏇挎崲瀹樻柟琛屽疄鐜帮級锛?- 涓嶅鍒?`dsh-plugin-desktop` 鏈韩锛屽澹充笌閰嶇疆褰掑睘鍏ㄦ槸 DSHOME 鑷繁鐨勩€?
## 5. 浠撳簱涓庡寘缁撴瀯锛堥鏋讹級

鍗?npm 鍖咃紙`co type: module`锛夛紝鍏堢函 JS 鏈€灏忓寲锛岄渶瑕佹椂鍐嶈縼 TS锛?
```
dshome/
鈹溾攢 package.json               # name: dshome锛沝sh.bundle.patch: ./cordis.patch.yml锛涘瓙璺緞 exports
鈹溾攢 cordis.patch.yml           # 缁勮琛ヤ竵锛堟牳蹇冧氦浠樼墿锛岃 搂6锛?鈹溾攢 lib/
鈹? 鈹溾攢 index.js                # 鍖呭叆鍙ｏ紙鍙┖澹筹紝浠呭湪闇€瑕佹椂鎸?host 鍒濆鍖栵級
鈹? 鈹溾攢 host/
鈹? 鈹? 鈹溾攢 shell.js             # dshome/shell锛欵lectron 绐楀彛/鎵樼洏/鍗曞疄渚?鐩戞祴/閫氱煡
鈹? 鈹? 鈹斺攢 core.js              # dshome/core锛氭彁渚?ctx.dshome 鏈嶅姟锛坈ommands/panels 娉ㄥ唽琛級
鈹? 鈹斺攢 client/
鈹?    鈹溾攢 core.js              # dshome/client-core锛歴lots 娉ㄥ唽 + 鍛戒护妗?鈹?    鈹斺攢 theme.js             # dshome/theme锛氫富棰?token 瑕嗙洊
鈹溾攢 scripts/
鈹? 鈹溾攢 dev.mjs                 # 寮€鍙戝惊鐜細鏋勫缓 + 鍚姩 dsh --profile dshome
鈹? 鈹斺攢 safe.mjs                # 鎭㈠妯″紡锛?-patch 涓存椂绂佺敤鍏ㄩ儴鑷湁鎻掍欢锛屽垽瀹氬穿婧冩潵婧愶紙瑙?搂13.5锛?鈹溾攢 docs/                      # 鏈柟妗?+ 瀹炴柦绗旇
鈹斺攢 README.md
```

瀛愯矾寰勮寮曠敤锛坄dshome/shell` 绛夛級鐓ф妱 `dsh-plugin-desktop/terminal`銆乣dsh-plugin-desktop/notifications` 鐨勫懡鍚嶇害瀹氾紱瀹炴柦鏃朵互 loader 瀹炴祴涓哄噯琛ュ叏 `package.json exports` 瀛愯矾寰勩€?
## 6. cordis.patch.yml 瑙勬牸锛堥鏋惰崏妗堬級

```yaml
# dshome锛歱rofile dshome 鐨?bundle 琛ヤ竵锛堢 3 灞傦紝鐩栧湪 dsh-base + dsh-web-app 涔嬩笂锛?
# 鈥斺€?鈶?澹充笌鑷湁鏈嶅姟锛坔ost锛夆€斺€?- insert:
    - id: dshome-shell
      name: dshome/shell
      config:
        windowTitle: DSHOME
        # 鍗曞疄渚嬨€佹墭鐩樸€佹椿鎬х洃娴嬨€佺绾块〉銆侀噸杩炪€佸揩鎹锋柟寮忋€佽嚜鍚紑鍏炽€侀€氱煡妗?    - id: dshome-core
      name: dshome/core

    # 鈥斺€?鈶?鑷湁 client 鎻掍欢锛坉sh.client 琛岋紝杩涘叆 __DSH_BOOT__ roster锛夆€斺€?    - id: dshome-client
      name: dshome/client-core
    - id: dshome-theme
      name: dshome/theme

# 鈥斺€?鈶?瑕嗙洊瀹樻柟琛岋紙鏁翠綋鏇挎崲 config锛屼笉鍚堝苟锛夆€斺€?# 绐楀彛鐢?dshome/shell 鎺ョ锛屼笉鍐嶈嚜鍔ㄥ紑娴忚鍣?- id: web-runtime
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts: []

# 涓撳睘绔彛锛屼笌鐜版湁 web profile锛?3120锛夌瓑骞跺瓨涓嶅啿绐侊紱鍚庣画鍙敼 webStartup 鍔ㄦ€佸垎閰?- id: webserver
  config:
    host: 127.0.0.1
    port: 3081

# 涓枃鐣岄潰
- id: locale
  config:
    locale: zh-CN

# 鈥斺€?鈶?楠ㄦ灦 roster锛氭渶灏忓彲鐢ㄩ泦锛堝叾浣欏畼鏂硅鎸夐渶 insert 寮€鍚級鈥斺€?# 锛堝畼鏂?web-app 灞傚凡鎸傝浇鍏ㄩ噺锛涢鏋惰嫢璧?鏈€灏?roster"锛岀敤 disabled 鍏虫帀涓嶇敤鐨勮锛?#   鎴栫洿鎺ュ湪 dshome 灞傞噸寤虹簿绠€ roster銆傛帹鑽愬墠鑰咃細宸噺鍏抽棴锛屽ぉ鐒跺彲閫嗐€傦級
```

> 瀹炴柦娉ㄦ剰锛歳oster 閲囩敤"鍏煎妯″紡 + 宸噺鍏抽棴"杩樻槸"鑷缓绮剧畝 roster"锛屼互瀹炴柦鏃?dsh-cmdline 鐨?composeProfile 瀹炴祴缁撴灉瀹氬ず锛涗袱绉嶉兘鍦ㄥ畼鏂规満鍒跺唴銆傛柟妗堝€惧悜**鍏煎妯″紡宸噺鍏抽棴**锛堟敼鍔ㄦ渶灏忋€佹渶鍙€嗭級銆?
## 7. 鍚勭粍浠惰鏍?
### 7.1 dshome/shell锛坔ost锛夛細钖勫３灞?鑱岃矗锛堝弬鑰?dsh-clean-desktop-shell 鍔熻兘闈級锛?- Electron 绐楀彛锛氭棤杈规鎴栭粯璁よ竟妗嗗彲閫夛紝绐楀彛鏍囬 `DSHOME`锛屽叧闂獥鍙ｆ渶灏忓寲鍒版墭鐩橈紱
- 绯荤粺鎵樼洏锛氱姸鎬佽彍鍗曪紙杩愯涓?鍚姩涓?鏈繍琛?閿欒锛夈€佸惎鍔?閲嶅惎/鍏抽棴鍚庣銆佹樉绀虹獥鍙ｃ€佸埛鏂般€侀€€鍑猴紱
- 鍗曞疄渚嬮攣锛氶噸澶嶅惎鍔ㄥ彧鑱氱劍宸叉湁绐楀彛锛?- 鍚庣娲绘€х洃娴嬶細杞 webserver锛涙寕鎺夊嵆绐楀彛鍒?鏈繛鎺?绂荤嚎椤碉紝鎭㈠鑷姩閲嶈繛鍔犺浇锛?- 妗岄潰蹇嵎鏂瑰紡锛氬彲閫夊垱寤猴紙`dsh --profile dshome` 鍙弻鍑诲惎鍔ㄧ殑 .lnk锛夛紱
- 寮€鏈鸿嚜鍚紑鍏筹紙Windows 娉ㄥ唽琛?Run 閿?/ lnk 鍒?Startup 鐩綍锛夛紱
- 閫氱煡妗ワ細璁㈤槄 Host 渚т换鍔?鍥炲悎/瀹℃壒浜嬩欢锛屽脊绯荤粺閫氱煡锛堝叿浣撲簨浠跺悕瀹炴柦鏃跺弬鐓?`dsh-plugin-desktop/notifications` 婧愮爜锛夛紱
- Electron 杩愯鏃剁瓥鐣ワ細寮€鍙戞湡 devDependency 鏈湴璺戯紱涓汉浣跨敤棣栨湡鐢?杩愯鏃舵寜闇€鍑嗗"锛坈lean-desktop-shell 鏂瑰紡锛夛紝浜у搧鍖栦簩鏈熸崲 Tauri 鏃剁Щ闄ゃ€?
### 7.2 dshome/core锛坔ost锛夛細鎵╁睍鐐规湇鍔?杩欐槸"鍚庣画涓€鍒囩殕鎻掍欢"鐨勫湴鍩恒€傛彁渚?`ctx.dshome` 鏈嶅姟锛?
```js
ctx.dshome = {
  commands: { register({ id, label, run }) },   // 鍛戒护娉ㄥ唽琛紙濡?Ctrl+K 闈㈡澘鏁版嵁婧愶級
  panels:   { register({ id, title, component }) }, // 闈㈡澘娉ㄥ唽琛紙渚ф爮/闄勫姞闈㈡澘浣嶏級
}
```
鏈潵鎵€鏈?DSHOME 鎻掍欢鍙緷璧栬繖涓湇鍔?+ 瀹樻柟 `dsh-client-ui-slots`锛堢涓夋柟娉ㄥ唽鏂版爣绛?浣嶇偣鐨勫畼鏂规満鍒讹紝瑙?`dsh-better-sidebar` 鍏堜緥锛夛紝涓嶅繀鏀?shell/core銆?
### 7.3 dshome/client-core锛坈lient锛?- 娴忚鍣ㄧ鍚姩閽╁瓙锛氱瓑寰?cordis 灏辩华鍚庢敞鍐屾彃妲介」銆佸懡浠ら潰鏉垮崰浣嶏紱
- 閫氳繃 connection/remote 涓?host 鐨?`ctx.dshome` 鏈嶅姟瀵归€氾紙鏂规硶锛氱粡瀹樻柟 api-gateway Remote 鏈哄埗娉ㄥ唽绔偣锛屽疄鏂芥椂瀵圭収 dsh-community-market 鐨?client/host 閫氫俊鏍蜂緥锛夈€?
### 7.4 dshome/theme锛坈lient锛?- 楠ㄦ灦闃舵锛氳鍙栧畼鏂?`dsh-client-ui-theme` 鐨勪富棰?seam 骞惰鐩栵紙涓婚 token銆丆SS 鍙橀噺銆佹槑鏆椾袱濂椼€佸己璋冭壊锛夛紱
- 鍏蜂綋 seam API 瀹炴柦鏃剁洿鎺ヨ `node_modules/@deepseek-ai/dsh-client-ui-theme/src`锛?- 甯傚満鐨偆鎻掍欢锛坄dsh-client-ui-skin-*`锛夌殑娉ㄥ叆鍐欐硶鏄幇鎴愬弬鐓с€?
## 8. 渚濊禆娓呭崟锛堥拤姝?0.1.1-rc.2锛?
| 渚濊禆 | 鐢ㄩ€?|
|---|---|
| `@deepseek-ai/dsh-base@^0.1.1-rc.2` | 绗?1 灞?host 鏍稿績锛?7 渚濊禆鐨勭粍瑁呰妭鐐癸級 |
| `@deepseek-ai/dsh-web-app@^0.1.1-rc.2` | 绗?2 灞傛祻瑙堝櫒闈紙webserver/web-runtime/瀹樻柟 roster/frontend dist锛?|
| `@deepseek-ai/cordis@4.0.1` | Cordis 杩愯妗嗘灦锛坧eer锛?|
| `electron` | 澹崇獥鍙ｈ繍琛屾椂锛坉evDependency锛涜繍琛屾椂涓嬭浇绛栫暐鍙﹁锛?|
| `react@18.3.1` | 鑷粯缁勪欢鏃舵墠闇€瑕侊紙瀹樻柟 renderer 鍚岀増鏈級 |

鍏朵綑瀹樻柟妯″潡锛坈lient-*/host-*锛夌敱 `dsh-web-app` 浼犻€掑甫鍏ワ紱DSHOME 闇€瑕侀澶栧紩鐢ㄧ殑鎸?roster 瑁佸壀鎯呭喌鍦ㄥ疄鏂芥湡琛ュ厖銆?
## 9. 鍒嗛樁娈靛疄鏂借鍒掞紙姣忎竴姝ラ兘鍙敱 dsh 浠ｇ悊浜や粯骞惰嚜妫€锛?
### Phase 0 路 鐜鍦板熀
- 纭鏈満 `dsh` CLI 鍙敤锛圖SH Desktop 鑷甫锛沗dsh --version`锛夛紱
- 纭 pnpm銆丯ode 24锛涘缓 `E:\DSH\dshome` 宸ョ▼鐩綍锛?- 楠岃瘉 `dsh plugin --profile dshome add <鏈湴璺緞>` 鏄惁鏀寔 file:/folder 褰㈠紡锛堝惁鍒欑敤 GitHub 璺緞锛夛紝璁板綍 CLI 瀹炴祴琛屼负锛?- **楠屾敹**锛歚dsh --profile dshome --help` 鍙В鏋愶紝鏃犳姤閿欍€?
### Phase 1 路 楠ㄦ灦 bundle锛堟棤绐楀彛锛?- 鎼?package.json锛坉sh.bundle.patch銆乪xports 瀛愯矾寰勩€佷緷璧栵級+ 鏈€灏?`cordis.patch.yml`锛堝彧 insert dshome-core锛屽叾浣欒鐩栭」鐣欐敞閲婏級锛?- 璺?`dsh --profile dshome`锛屾祻瑙堝櫒鎵嬪姩璁块棶 `127.0.0.1:3081`锛?- **楠屾敹**锛氬畼鏂逛腑鏂?UI 鍙銆佸彲寤轰細璇濄€佸彲鍙戞秷鎭€佹ā鍨嬪彲閰嶇疆锛涗笌 `--profile web`锛?3120锛夊苟瀛樻棤鍐茬獊銆?
### Phase 2 路 钖勫３
- 瀹炵幇 `dshome/shell`锛堢獥鍙?鎵樼洏/鍗曞疄渚?鐩戞祴/绂荤嚎椤?閲嶈繛/蹇嵎鏂瑰紡/鑷惎寮€鍏筹級锛?- **楠屾敹**锛氬弻鍑诲揩鎹锋柟寮忓嚭绐楋紱鍏崇獥涓嶉€€鍑猴紱鎵樼洏鍙惎鍋滃悗绔紱鏉€鎺夊悗绔啋绂荤嚎椤碉紝閲嶅惎鈫掕嚜鍔ㄩ噸杩烇紱閲嶅鍚姩鍙仛鐒︺€?
### Phase 3 路 涓婚 + 鎵╁睍鐐规紨绀?- 瀹炵幇 `dshome/theme`锛堟槑鏆?+ 寮鸿皟鑹诧紝鑲夌溂鍙鲸锛夛紱
- 瀹炵幇 `dshome/client-core` + 涓€涓紨绀烘墿灞曪紙濡傛敞鍐屼竴涓?`/dshome-demo` 鍛戒护鎴栦晶鏍忛」锛夛紝璧?`ctx.dshome.commands` + 瀹樻柟 slots锛?- **楠屾敹**锛氫富棰樼敓鏁堬紱婕旂ず鎵╁睍鍙鍙敤锛涘啀瑁呬竴涓競鍦虹幇鎴?client 鎻掍欢锛堝鏌?skin锛夊埌 profile 涓嶅啿绐侊紙璇佹槑"鍚庣画鐨嗘彃浠?鎴愮珛锛夈€?
### Phase 4 路 鏀跺熬
- 琛?README锛堝畨瑁?鍚姩/寮€鍙戝惊鐜剼鏈?`scripts/dev.mjs`锛夛紱鏁寸悊瀹炴柦绗旇鍒?docs/锛?- 璺戦€?搂10 鍏ㄩ噺楠岃瘉娓呭崟锛?- 鍐欎簩鏈熻矾绾匡紙搂12锛夎惤搴撱€?
### 9.1 璺戦€氬悗鐨勫紑鍙戝惊鐜紙濡備綍鍦ㄥ３閲屾寔缁凯浠ｏ級

绗竴鐗堣窇閫氬悗锛岀敤鎴峰彲鐩存帴鍦?DSHOME 涓婄户缁紭鍖栦笌寮€鍙戯紝鎸変笁灞傜儹鏇磋妭濂忥細

| 鏀瑰姩瀵硅薄 | 鐢熸晥鏂瑰紡 | 棰戠巼 |
|---|---|---|
| client 鎻掍欢锛堜富棰?闈㈡澘/鍛戒护/甯冨眬锛?| HMR 鐑洿鏂帮細`dev.mjs` 鐨?watcher + 瀹樻柟 `client-hmr` 琛岋紝鏀瑰畬鍗冲埛锛岀獥鍙ｄ笉鍏?| 绉掔骇 |
| host 鎻掍欢锛堟墭鐩?鐩戞祴/閫氱煡妗?core锛?| 鎵樼洏涓€閿?閲嶅惎鍚庣"锛屽３娲绘€х洃娴嬭嚜鍔ㄩ噸杩炵獥鍙?| 閲嶅惎鍚庣 |
| Electron 澹虫湰韬?| 寮€鍙戞ā寮?`electron .` 鐩磋繛宸茶窇鐨勫悗绔紝鏀瑰３涓嶅姩鍚庣 | 鍙噸鍚３ |
| cordis.patch.yml / 渚濊禆鍙樻洿 | `--patch` 瑕嗙洊灞傚疄楠?鈫?纭鍚庡悎骞?鈫?閲嶅惎 profile锛坈heckpoint 鍙洖婊氾級 | 閲嶅惎 |

**閾佸緥**锛堥槻姝㈣凯浠ｅ彉浜嬫晠锛夛細
1. 鑷爺浠ｇ爜鍙繘 `dshome` 鍖呬笌鑷湁鎻掍欢锛沗node_modules/@deepseek-ai/*` 瀹樻柟 bundle **鍙**锛?2. 瀹為獙涓€寰嬭蛋 `--patch` 瑕嗙洊灞傦紝纭鍚庤惤鍦帮紱閰嶅悎 Recovery checkpoint 涓€閿洖婊氾紱
3. 寮€鍙戝満鍦帮紙`dshome` + 宸ヤ綔鍖猴級涓?`--profile web` 闅旂锛屽畼鏂圭晫闈㈠缁堟槸瀹夊叏缃戯紱
4. 鍙?dogfood锛氬湪 DSHOME 绐楀彛鍐呭紑浼氳瘽锛岃浠ｇ悊缁х画寮€鍙?DSHOME 鑷韩锛堜唬鐮佷骇鐗╄惤 `E:\DSH\dshome`锛夈€?
**杈圭晫鎻愰啋**锛欻MR 浠呭湪 dev watcher 杩愯鏈熼棿鐢熸晥锛岀敓浜у舰鎬佹敼 client 浠ｇ爜闇€ rebuild + refresh锛沨ost/琛ヤ竵鍙樻洿蹇呴』閲嶅惎锛堜唬浠峰凡琚３鐨勮嚜鍔ㄩ噸杩炴姷娑堬級銆?
## 10. 楠岃瘉娓呭崟锛堥鏋?璺戦€?瀹氫箟锛?
- [ ] `dsh --profile dshome` 涓€鏉″懡浠ゅ彲鍚姩锛涚鍙?3081 涓婄嚎锛堟垨閰嶇疆鍊硷級
- [ ] Electron 绐楀彛寮瑰嚭锛屾爣棰?DSHOME锛岄〉闈负涓枃瀹樻柟 UI + DSHOME 涓婚
- [ ] 鑳芥柊寤轰細璇濆苟瀹屾垚涓€杞璇濓紱妯″瀷/鎻愪緵鏂硅缃彲鏀?- [ ] 鎵樼洏瀛樺湪锛涘崟瀹炰緥鐢熸晥锛涘叧绐楁渶灏忓寲鍒版墭鐩橈紱寮€鏈鸿嚜鍚紑鍏冲彲閫?- [ ] 鍚庣琚潃 鈫?绂荤嚎椤碉紱閲嶅惎鍚庣 鈫?鑷姩閲嶈繛
- [ ] 浠诲姟瀹屾垚/闇€瑕佸鎵规椂寮圭郴缁熼€氱煡
- [ ] 婕旂ず鎵╁睍锛堝懡浠?闈㈡澘锛夐€氳繃 dshome 鎵╁睍鐐规敞鍐屽苟鍙
- [ ] **鏁呴殰婕旂粌**锛氭敞鍏ヤ竴涓晠鎰忔姏閿欑殑鑷湁鎻掍欢 鈫?鈶?`--profile web` 涓嶅彈褰卞搷 鈶?`scripts/safe.mjs` 绂佺敤璇ヨ鍚?DSHOME 姝ｅ父鍚姩 鈶?澹崇绾块〉 + 鎵樼洏閲嶅惎鍚庣鍙仮澶嶏紙瑙?搂13.5锛?- [ ] 涓庣幇鏈?`--profile web` 瀹炰緥骞跺瓨浜掍笉骞叉壈
- [ ] 鏈満鍏朵粬 .lnk / 鍙屽嚮娴佺▼鍙敤

## 11. 鎵╁睍鐐硅鑼冿紙鏈潵鎻掍欢鐨勬帴鍏ュ绾︼級

| 鎻掍欢绫诲瀷 | 鎺ュ叆鏂瑰紡 | 鍏堜緥 |
|---|---|---|
| 涓婚/鐨偆 | `dsh.client` 娉ㄥ叆锛岃鍐?ui-theme seam | `dsh-client-ui-skin-*` 甯傚満鍖?|
| 鍛戒护锛堝惈 Ctrl+K 闈㈡澘锛?| `ctx.dshome.commands.register(...)` | 瀹樻柟 ui-commands + dshome/core |
| 渚ф爮/闄勫姞闈㈡澘 | 瀹樻柟 `dsh-client-ui-slots` 娉ㄥ唽浣嶇偣 / `ctx.dshome.panels.register(...)` | `dsh-better-sidebar` |
| host 鑳藉姏锛堟墭鐩橀」銆侀€氱煡銆佺綉鍏筹級 | 琛?insert `name: <pkg>/<subpath>`锛屾敞鍏?dshome 鏈嶅姟鎴栧畼鏂规湇鍔?| `dsh-plugin-desktop/*` 绯诲垪 |
| 鐩存帴瑁呭競鍦虹幇鎴愭彃浠?| `dsh plugin --profile dshome add <鍖?`锛堜笉鏀?dshome 浠ｇ爜锛?| 鈥斺€?|

鍐嶅己璋冿細楠ㄦ灦蹇呴』鍦?Phase 1 灏辨妸 **鈶?profile/bundle 鏍囪瘑 鈶?cordis.patch.yml 鍒嗗眰 鈶?ctx.dshome 鏈嶅姟** 涓変釜鎵╁睍鐐圭珛浣忥紝鍚庣画鎻掍欢鎵?鍙瑁呭氨瑁?銆?
## 12. 浜屾湡璺嚎鍥撅紙鎻掍欢鍖栵紝闈為鏋跺唴瀹癸級

1. **鍛戒护闈㈡澘**锛圕trl+K锛氬垏妯″瀷/鍒囧伐浣滅洰褰?寮€浼氳瘽锛夆啋 dshome 鎵╁睍鎻掍欢
2. **浼氳瘽鏀惰棌/缃《**锛氫晶鏍忎綅鐐规敞鍐屾彃浠?3. **闄勫姞闈㈡澘**锛氬伐浣滅洰褰曟枃浠舵爲 / 浠诲姟鐪嬫澘 / token 鐢ㄩ噺灏忓崱鐗?鈫?panels 娉ㄥ唽琛ㄦ彃浠?4. **鎵嬫満杩滅▼璁块棶**锛氬弬鑰冨競鍦虹綉鍏崇被鎻掍欢锛坉sh-remote-* / dsh-mobile-pwa锛?5. **浜у搧鍖栧澹?*锛歍auri v2 鍗?exe锛堢豢鑹插垎鍙戯紝RFC 鏃惰瘎浼帮級锛屾垨 npm 鍙戝竷 `dshome` 渚涘競鍦哄畨瑁?6. **macOS**銆佹繁鑹?娴呰壊澶氫富棰樺寘銆佽嚜鏈夊墠绔粍浠堕€愭鏇挎崲瀹樻柟琛岋紙鍒╃敤 roster 鍙彃鎷旀€ф帹杩涘埌"鍏ㄨ嚜鏈夌晫闈?锛?
## 13. 椋庨櫓涓庡绛?
| 椋庨櫓 | 瀵圭瓥 |
|---|---|
| bundle/鎻掍欢瀛楁璇箟涓庡畼鏂规枃妗ｆ湁鍑哄叆 | 瀹炴柦鏃朵互鏈満 `node_modules/@deepseek-ai/dsh-cmdline`銆乣dsh-app-boot` 婧愮爜涓?`dsh plugin` 瀹炴祴涓哄噯锛堟湰鏈哄嵆鏈?2.0.3 瀹屾暣瑙ｅ寘鍓湰锛?|
| Electron 杩愯鏃堕娆′笅杞芥參/缃戠粶鍙楅檺 | 鎵嬪姩鏀剧疆杩愯鏃惰矾寰勯€夐」锛涙垨鍏堢敤绯荤粺娴忚鍣ㄩ獙璇?Phase 1 鍐嶈繘 Phase 2 |
| 绔彛鍐茬獊锛堝涓?profile 鍚屾満锛?| DSHOME 涓撳睘榛樿绔彛 + webStartup 鍔ㄦ€佸垎閰嶅厹搴?|
| 涓婃父 `0.1.1-rc.2` 鍗囩骇婕傜Щ | 璺熼殢 DSH Desktop 鐨?pin 绛栫暐锛屽崌鐗堣蛋鐙珛楠岃瘉 |
| 涓婚 seam API 鏈煡缁嗚妭 | 璇?`node_modules/@deepseek-ai/dsh-client-ui-theme/src` 鍚庡疄鐜帮紙鏈夊競鍦?skin 鍏堜緥鍏滃簳锛?|
| 鑷粯 UI 宸ヤ綔閲忓け鎺?| 楠ㄦ灦绂佹鑷粯锛涜嚜缁樹竴寰嬭繘浜屾湡骞惰蛋 roster 鏇挎崲璺嚎 |

## 13.5 闃插穿婧冧笌鍙仮澶嶆€ц璁★紙楠ㄦ灦纭€ц姹傦級

**缁撹**锛氭彃浠跺仛宕╀簡 DSHOME 鑳芥甯稿惎鍔ㄢ€斺€斾絾杩欐槸璁捐淇濊瘉锛屼笉鏄嚜鍔ㄨ涓恒€傞鏋跺繀椤诲疄鐜颁互涓嬫姢鏍忥紝骞舵妸"鏁呴殰婕旂粌"鍒椾负楠屾敹椤癸紙搂10锛夈€?
**瀹樻柟宸叉牳瀹炵殑鍦板熀**锛堟湰鏈?2.0.3 婧愮爜锛夛細
- 閰嶇疆搴旂敤**浜嬪姟鍖?*锛氬け璐ヨ嚜鍔ㄥ洖婊氬埌"涓婁竴涓ソ鏍?锛坉sh-app-boot锛歚the last good tree remains active when rollback succeeds`锛夛紱
- boot 瀹夎 **fail-loud Loader 瀹堝崼**锛屽惎鍔ㄩ敊璇ぇ澹板け璐ャ€佷笉鐣欏崐娈嬬姸鎬侊紙dsh-app-boot lib/index.js锛夛紱
- loader 灞?*鑱氬悎閿欒 + 鍥炴粴**锛坈ordis-plugin-loader锛歟ntries 澶辫触 鈫?AggregateError 鈫?rollback锛夛紱
- 瀹樻柟鎭㈠璇婃柇 `--dump-default-config`锛氬潖鐨勭敤鎴峰眰涔熻兘鍑鸿瘖鏂紙dsh-app-boot lib/index.js:535-536锛夛紱
- DSH Desktop 鑷甫 recovery/setup-wizard 鐣岄潰涓?鍋ュ悍鍚姩 checkpoint"鏈哄埗锛坣ative-ui/recovery.html锛沝sh-community-market README锛夈€?
**DSHOME 浜斿眰闃叉姢**锛?
| 灞?| 鏈哄埗 | 褰掑睘 |
|---|---|---|
| L0 鏁呴殰鍩熼殧绂?| 姣?profile 鐙珛杩涚▼锛涘３锛圗lectron锛変笌鍚庣锛圕ordis host锛夎繘绋嬪垎绂伙紝浜掍笉鎷栧灝 | 瀹樻柟 + DSHOME 澹?|
| L1 浜嬪姟鍖栧惎鍔?| 閰嶇疆鍥炴粴鍒颁笂涓€涓ソ鏍?+ fail-loud 瀹堝崼 + 鎭㈠璇婃柇 | 瀹樻柟锛堢洿鎺ョ户鎵匡級 |
| L2 琛岀骇鍙鐢?| 琛ヤ竵鍒嗗眰瑕嗙洊锛歚--patch` 瑕嗙洊灞備竴琛?`disabled: true` 鍗冲彲绂佺敤浠绘剰鑷湁鎻掍欢锛沗scripts/safe.mjs` 涓€閿?绂佺敤鍏ㄩ儴鑷湁鎻掍欢"鍚姩锛岀绾у垽瀹氬穿婧冩潵婧?| DSHOME 鑴氭湰 |
| L3 澹冲眰娲绘€ф仮澶?| 鍚庣琚潃 鈫?绂荤嚎椤?鈫?鎵樼洏涓€閿噸鍚悗绔?鈫?鑷姩閲嶈繛 | DSHOME 澹?|
| L4 鑷湁鎻掍欢鎶ゆ爮 | 鎻掍欢鐧昏鍏?try/catch + 鏈嶅姟闄嶇骇锛堟壘涓嶅埌瀹樻柟鏈嶅姟灏变笉娉ㄥ唽锛岀粷涓?throw 闃绘柇鍚姩锛夛紱client 鎻掍欢宕╂簝 鈫?闄嶇骇涓烘棤瀹氬埗瀹樻柟 UI锛?*涓嶆槸鐧藉睆** | DSHOME 浠ｇ爜瑙勮寖 |

**宕╂簝鍒嗙骇涓庢仮澶嶈矾寰?*锛?- 鑷湁 client 鎻掍欢宕?鈫?L4 闄嶇骇 / L2 绂佺敤锛?- 鑷湁 host 鎻掍欢宕?鈫?L0 绂荤嚎椤?+ L2 绂佺敤鍚庨噸鍚紱
- 閰嶇疆鎹熷潖 鈫?L1 鍥炴粴 / 瀹樻柟 recovery 涓庤瘖鏂紱
- 涓婃父锛堝畼鏂?bundle锛夊眰闂 鈫?pin 鐗堟湰 + 鍗囩骇绛栫暐锛屼笉灞炰簬楠ㄦ灦鍙槻鑼冨洿銆?
**鍙傝€冨厛渚嬶紙姣忓眰閮芥湁鐜版湁椤圭洰鑳屼功锛岄潪鑷垱锛?*锛?
| 灞?| DSH 鐢熸€佸唴鍏堜緥锛堝凡鏍稿疄锛?| 鐢熸€佸閫氱敤鍋氭硶 |
|---|---|---|
| L0 杩涚▼闅旂 | profile 鐙珛杩涚▼锛汥SH Desktop 涓?娓叉煋杩涚▼鍒嗙 | VS Code 鎵╁睍瀹夸富杩涚▼闅旂锛汣hrome process-per-extension锛汦lectron render-process-gone 閲嶅惎绐楀彛 |
| L1 浜嬪姟鍖栧惎鍔?| dsh-app-boot "涓婁竴涓ソ鏍?鍥炴粴锛?*DSH Desktop 鐨?Recovery checkpoint**锛氭彃浠跺畨瑁?绉婚櫎鍓嶇敓鎴愭仮澶嶇偣锛屽け璐ユ彁绀?Use a Recovery checkpoint to restore the previous Profile state"锛坉sh-community-market/service.js:459/526锛夛紱desktop-cli.js:43 "Manual plugin commands and Market operations rely on unified checkpoints" | 娴忚鍣ㄩ厤缃牎楠屼繚鐣?last-good锛涘寘绠＄悊鍣ㄥ師瀛愬畨瑁?|
| L2 琛岀骇鍙鐢?| patch 瑕嗙洊灞?disabled锛?*DSH Desktop 鑷甫"閲嶅惎鍒版仮澶嶆ā寮?**锛?api/desktop/restart/recovery + LifeBuoy 鑿滃崟椤癸紝lib/client.js:35756/35931锛?| VS Code `--disable-extensions`锛坰afe.mjs 鍗?DSH 鐗堬級锛汣hrome 宕╂簝鎵╁睍鑷姩 quarantine |
| L3 澹冲眰娲绘€ф仮澶?| dsh-clean-desktop-shell 宸查獙璇侊細娲绘€х洃娴?+ 绂荤嚎椤?+ 鑷姩閲嶈繛 + 鎵樼洏閲嶅惎鍚庣 | Chrome 鏍囩宕╂簝鎭㈠椤碉紱Electron 娓叉煋杩涚▼宕╂簝鍏滃簳 |
| L4 闄嶇骇鎶ゆ爮 | 瀹樻柟 renderer 涓?React 18锛涜嚜鏈夌粍浠跺寘 Error Boundary锛堝眬閮ㄥ穿婧冧笉鐧藉睆锛?| React Error Boundary锛涙祻瑙堝櫒鎵╁睍杩愯鏃堕敊璇殧绂伙紙鎵╁睍宕╂簝涓嶆嫋鍨〉闈級 |

> 缁撹锛氭湰鏂规浜斿眰闃叉姢姣忎竴椤归兘鑳藉湪鐜版湁椤圭洰閲屾壘鍒板搴斿厛渚嬶紱楠ㄦ灦涓嶅彂鏄庢柊鏈哄埗锛屽彧鎶婂凡楠岃瘉妯″紡缁勮鍒?DSHOME 骞剁撼鍏ラ獙鏀躲€?
**鎶ゆ爮缂栫爜瑙勮寖锛堥鏋朵唬鐮佸繀椤婚伒瀹堬級**锛?1. 鎵€鏈夎嚜鏈夋彃浠跺惎鍔ㄩ€昏緫 try/catch锛岄敊璇彧璁版棩蹇椾笉 rethrow锛?2. 渚濊禆瀹樻柟鏈嶅姟涓€寰?`ctx.get`/鍙€夎幏鍙栵紝缂哄け鍗宠烦杩囨敞鍐岋紱
3. client 绔敞鍐岋紙slots/鍛戒护锛夊け璐ラ潤榛橀檷绾э紝淇濊瘉瀹樻柟 UI 鍙覆鏌擄紱
4. 姣忎釜鑷湁鎻掍欢鐙珛鎴愯锛屽彲鍗曠嫭 `disabled`銆?
## 14. 鍙傝€冩竻鍗曪紙鏈満鍙鐨勬潈濞佸弬鐓э級

- 瀹樻柟 web 琛ヤ竵/roster锛歚E:\DSH\app.src\node_modules\@deepseek-ai\dsh-web-app\cordis.patch.yml`
- 鍩哄骇灞傦細`E:\DSH\app.src\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml`锛堝惈 77 渚濊禆鏍稿績琛岋級
- 妗岄潰鍏煎妯″紡妯℃澘锛歚E:\DSH\app.src\cordis.patch.yml`
- 瀹㈡埛绔敞鍏ュ０鏄庢牱渚嬶細`E:\DSH\app.src\node_modules\dsh-community-market\package.json`锛坉sh.client.inject 瀛楁锛?- 鎻掍欢褰㈡€佽杽澹冲姛鑳介潰锛欸itHub `Icather/dsh-clean-desktop-shell`锛圧EADME 宸叉牳瀹烇級
- 甯傚満鐢熸€侊細1024Store `https://deepseek1024.com/api/v2/plugins`锛坈lient/terminal/mobile/desktop shell 鍒嗙被妫€绱級
- 涓婃父瀹樻柟锛歚github.com/deepseek-ai/deepseek-harness`锛汥SH Desktop 绀惧尯瀹炵幇锛歚github.com/anywhere-labs/deepseek-harness-desktop`

---

> 鏈枃妗ｅ嵆"瀹屾暣璁捐鏂规"銆傚疄鏂芥椂鎸?Phase 0鈫? 椤哄簭鎵ц锛屾瘡闃舵楠屾敹閫氳繃鍐嶈繘涓嬩竴闃舵锛涗换浣曚笌鏈枃妗?寰呭疄娴?鏍囨敞鍐茬獊鐨勫畼鏂硅涓猴紝浠ュ疄娴?+ 瀹樻柟婧愮爜涓哄噯骞跺洖濉湰鏂囨。銆?
---

## 15. 瀹炴柦璁板綍锛圥hase 0鈥? 瀹炴祴缁撹 2026-08-28锛?
**缁撹鍏堣**锛歚dsh --profile dshome` 宸插湪鏈満鐢?*瀹樻柟 dsh CLI** 璺戦€氾紱`http://127.0.0.1:3081` 杩斿洖 200锛宍__DSH_BOOT__` 娉ㄥ叆瀹屾暣瀹樻柟 client roster锛?8 涓ā鍧楋級锛屼笌鐜版湁 web profile锛?3120锛夊苟瀛樹簰涓嶅共鎵般€備唬鐮佸湪 `E:\DSH\dshome`锛宲rofile 鍦?`C:\Users\kuro\.dsh\profiles\dshome`銆?
### 15.1 "寰呭疄娴?椤圭洰闂幆

| 寰呭疄娴嬮」 | 缁撹 |
|---|---|
| profile 鐩綍缁撴瀯 | `$DSH_HOME/profiles/<name>/`锛歱ackage.json锛坄dsh.profile.bundles` 澹版槑琛ヤ竵灞傚簭锛? 鐢ㄦ埛灞?`cordis.patch.yml` + `cordis.yml`锛堝嬁鏀癸級+ `pnpm-workspace.yaml`锛涘姞杞藉櫒杩樹細璇?`$DSH_HOME/cordis.patch.yml`锛坔ome 灞傦級 |
| 鍚姩鍛戒护 | `dsh --profile dshome [--no-open] [--port <n>\|0]`锛沗--port 0` 璁╃郴缁熸寫绌洪棽鍙?|
| 绔彛绛栫暐 | **webserver 琛?config 涓嶈鍐欐绔彛**锛堜細閽冲埗 CLI 鍙傛暟锛夛紝涓€寰嬬粡 CLI `--port` |
| locale | 涓嶈蛋琛ヤ竵瑕嗙洊琛岋細璁剧疆椤?`locale.preference: zh\|en`锛堢己鐪佽窡闅忔祻瑙堝櫒锛夛紝涓枃 UI 鐢辨祻瑙堝櫒 zh 鑷姩鐢熸晥 |
| profile 渚濊禆 | **閲嶅ぇ鍙戠幇**锛欳LI 鍔犺浇鍣ㄤ粠 profile 鑷韩鐩綍瑙ｆ瀽鎵€鏈夎鍖?鈫?瀹樻柟 bundles 蹇呴』**鏄惧紡鍐欒繘 profile dependencies**锛坄dsh-base`/`dsh-web-app` 绮剧‘鐗堟湰锛? workspace `autoInstallPeers: true`銆倃eb/desktop 鐨勭┖ dependencies 妯″紡鍙湪 GUI锛坅pp.asar 鍐呯疆渚濊禆锛夋垚绔嬶紱鍚屾満 CLI 璺緞浼氭姤 `Cannot find package 鈥?imported from <profile>` |
| dump 璇婃柇 | `--dump-config` / `--dump-default-config` 绂荤嚎缁勫悎鍙敤锛涚閬撴彁鍓嶅叧闂紙`Select-Object -First`锛変細閫犳垚 EPIPE 璇姤 exit 1锛岄潪鐪熷疄閿欒 |

### 15.2 宸茬‘璁ょ殑瀹樻柟鏈哄埗锛堟簮鐮佺骇锛?
- `runProfile` 鎶?`options.environment`锛坄loadLayeredEnv` 蹇収锛屽甫 `.get`锛夋敞鍐屼负 `launchEnvironment` 鏈嶅姟锛沴lm-deepseek 绛夌粡瀹冭鍙?`environment?.get(...)?.value`鈥斺€旇瘖鏂剼鏈?*涓嶈兘**浼犺８ `process.env`锛?- 鍚姩澶辫触鍙墦鍗伴《灞傛秷鎭紝瀛愰敊璇棌鍦?`error.errors`锛堣瘖鏂伐鍏凤細`dshome/probe.mjs`锛屽彲鎵撳嵃浠绘剰 profile 鐨勬繁灞傞敊璇級锛?- 澶辫触鍙戠敓鍦ㄨ鎸傝浇/瀵煎叆闃舵鏃讹紝鎶ラ敊鍚?`imported from <profile鐩綍>`锛屽彲鐩存帴瀹氫綅缂哄寘/缂?peers銆?
### 15.3 宸茬煡闂涓庡绛?
| 闂 | 瀵圭瓥 |
|---|---|
| `pnpm install` 浼氫负 sharp 绛夎法骞冲彴鍙€?tarball 闀挎椂闂撮噸璇曪紙error 23锛?| 闈炶嚧鍛斤細渚濊禆鏍戣榻愬嵆鍙惎鍔紝鏃犻渶绛夐噸璇曠粨鏉燂紱蹇呰鏃舵崲闀滃儚 |
| 鍘熺敓 module build 榛樿琚烦杩囷紙node-pty/koffi/protobufjs/@google/genai/dsh-subprocess-local锛?| Phase 1 鏃犵粓绔?鍘熺敓鑳藉姏锛屼笉鍙楀奖鍝嶏紱Phase 2 澹?缁堢鍓嶉渶 `allowBuilds: true` 鍚庨噸瑁呮垨 `pnpm approve-builds` |
| dshome-core 鐨?info 鏃ュ織涓嶅嚭鐜颁簬 CLI stdout锛堟棩蹇楀幓鍚戝皝瑁咃級 | 琛屾寕杞芥棤鎶ラ敊鍗充负婵€娲伙紱Phase 3 鐢?UI 鍙鎬у仛杩愯鏃堕獙璇?|
| 璋冭瘯娈嬬暀锛坧robe.mjs / probe-asar.mjs / wrapper.mjs / bisect-1.yml锛?| 淇濈暀涓鸿瘖鏂伐鍏凤紱`bisect-1.yml` 鍗?瑕嗙洊灞傜鐢?浜屽垎鐨勫疄璇?|

### 15.4 甯哥敤鍛戒护

```
dsh --profile dshome --no-open --port 3081   # 鍚姩锛堟闈㈠３鎺ュ叆鍓嶆帹鑽愶級
dsh --profile dshome --port 0                # 绯荤粺鎸戠┖闂茬鍙?dsh --profile dshome --dump-config           # 鏌ョ湅缁勫悎鍚庣殑瀹屾暣鏍戯紙鍚敤鎴峰眰锛?node E:\DSH\dshome\scripts\dev.mjs           # 寮€鍙戝惊鐜紙绛変环鍚姩锛?node E:\DSH\dshome\scripts\safe.mjs          # 鎭㈠妯″紡锛堢鐢ㄥ叏閮ㄨ嚜鏈夋彃浠跺惎鍔級
```

**妗岄潰蹇嵎鏂瑰紡锛堝厤缁堢锛?*锛歚DSHOME.lnk`锛坵script 闅愯棌鍚姩 `scripts/launch.vbs` 鈫?鍚庣闅愯棌鎺у埗鍙拌繍琛?+ 绐楀彛鑷姩寮瑰嚭锛変笌 `DSHOME 鍋滄.lnk`锛坄scripts/stop.cmd`锛岀粨鏉?3081 鍚庣锛夈€傚惎鍔ㄥ櫒娴嬭瘯妯″紡锛歚DSHOME_LAUNCH_TEST=1` 鏃跺彧鍐欐爣璁版枃浠朵笉鍚姩銆?
### 15.5 Phase 1 琛ュ厖楠岃瘉锛堢鍒扮鑱婂ぉ + 杩愯鏃惰В鏋愬喅绛栵級

**RPC 閫氶亾**锛堜笌娴忚鍣?UI 鍚屼竴鏉′紶杈擄級锛歚POST /api/<method>`锛屼俊灏?`{"type":"client-request","rpcId":"<string>","method":"<domain.method>","params":{...},"payload":{...}}`銆?- list/create 璧扮獎褰?`params`锛沺rompt 绛?`RequestPayload` 鏂规硶杩橀渶鎶婁笟鍔″璞″悓鏃舵斁杩?`payload` 妲斤紱
- Host 椤讳负 loopback/鍚屾簮锛坄Origin` 鍚?host 鍗冲彲锛夛紱
- `session.history` 杩斿洖 `value.events` 浜嬩欢娴侊細`assistant/chunk`锛坱ext-delta / usage / finish锛夈€乣assistant/message`銆乣turn/end`銆?
**绔埌绔粨鏋?*锛歚session.create 鈫?session.prompt("璇峰彧鍥炲涓や釜瀛楋細浣犲ソ") 鈫?妯″瀷娴佸紡鍥炲"浣犲ソ"锛坧rovider opencode-go / deepseek-v4-flash锛岃鍙?home 鍑嵁涓庤矾鐢憋級鈫?turn/end`銆俙verify-chat.mjs` 缁跨伅锛坋xit 0锛夈€傝瘖鏂伐鍏凤細`probe-rpc.mjs`锛堜换鎰忔柟娉曪級銆乣probe-history.mjs`锛堜簨浠舵祦灏鹃儴锛夈€?
**杩愯鏃惰В鏋愬喅绛栵紙鏈満 v1锛?*锛歴tandard/code/cordis/minimal 鍥涗釜 agent preset 寮曠敤绾?30 涓?`@deepseek-ai/dsh-tool-*` 鍖咃紝鍏朵腑灏戞暟鏈彂甯冨埌 npm锛堝 auto-peer 鐨?`dsh-compact` 404锛夛紝绾?pnpm 鏃犳硶瑁呴綈銆?*鏈満 v1 閲囩敤 junction 鏂规**锛?- `profiles/dshome/node_modules` 鈫?`E:\DSH\app.src\node_modules`锛坅pp.asar 瑙ｅ寘鍏ㄦ爲锛?99 涓?@deepseek-ai 鍖咃級锛?- `profiles/dshome/node_modules/dshome` 鈫?`E:\DSH\dshome`锛堝寘鏈綋锛夛紱
- 鍘熺敓棰勭紪璇戯紙koffi / node-pty / sharp / node-addon-require-builtin锛変粠 `app.asar.unpacked\node_modules` 鎷疯礉杩涜鏍戯紱
- 鍘?pnpm 鏍戝浠戒负 `node_modules.pnpm`銆?娉ㄦ剰锛歫unction 鎺ョ鍚?`dsh plugin add`锛堣蛋 pnpm锛変笉閫傜敤锛涗笂娓歌ˉ鍙戠己澶卞寘鍚庡簲鍥炲綊 pnpm 瀹夎銆傚惎鍔ㄥ懡浠や笉鍙樸€?
### 15.6 Phase 2 钖勫３瀹炴柦璁板綍锛?026-08-28锛?
**浜や粯**锛歚dsh --profile dshome` 鍚姩鍗宠嚜鍔ㄥ脊鍑?DSHOME 绐楀彛锛堝畼鏂?UI锛夛紝鎵樼洏甯搁┗銆佸崟瀹炰緥銆佸悗绔鏉€澹冲瓨娲诲苟鍒囩绾块〉銆佸悗绔仮澶嶈嚜鍔ㄩ噸杩炪€?
**浠ｇ爜**锛?- `dshome/shell-app/`锛欵lectron 绐楀彛搴旂敤锛坢ain.cjs / offline.html / icon.png锛夆€斺€斿崟瀹炰緥閿併€乧lose 鏈€灏忓寲鍒版墭鐩樸€?s 杞娲绘€с€佺绾块〉 + 鑷姩閲嶈繛銆佹墭鐩橈紙鏄剧ず/鍒锋柊/鑷惎寮€鍏?閫€鍑猴級銆佹湰鍦伴€氱煡鐩戝惉锛坄DSHOME_NOTIFY_PORT`锛孭OST /notify锛寁1.1 鎺ョ嚎锛夛紱
- `dshome/lib/host/shell.js`锛歨ost 鎻掍欢锛坄dshome/shell` 琛岋級锛屽悗绔氨缁悗 spawn GUI锛宍createRequire` 浠?dshome 鍖呮湰鍦拌В鏋?electron銆?- electron 渚濊禆锛歯pm registry 鏋佹參/澶辫触 鈫?npmmirror 鎵嬪姩涓嬭浇 138MB + tar 瑙ｅ寘鍒?`node_modules/electron/dist` + `path.txt=electron.exe`锛堣鏈哄疄褰曪紱鍏朵粬鏈哄櫒寤鸿 `npm i -D electron@43.4.0` 閰?`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`锛夈€?
**涓変釜鍏抽敭鍧戯紙鍧囧凡淇級**锛?1. `dsh.cmd` 浼氭妸 `ELECTRON_RUN_AS_NODE=1` 甯﹁繘鐜 鈫?spawn GUI 鍓嶅繀椤诲垹闄わ紝鍚﹀垯 Electron 浠?node 妯″紡杩愯銆佷笉鍑虹獥鍙ｏ紱
2. **蹇呴』 `detached: true` + `child.unref()`**锛氬惁鍒欏悗绔繘绋嬶紙鐖讹級閫€鍑?琚潃鏃跺３浼氶殢杩涚▼缁勯櫔钁紙瀹炴祴澶嶇幇鍚庝慨澶嶏級锛?3. 鍚庣閲嶅惎鏃舵彃浠朵細鍐嶆 spawn 鈫?闈犲３鐨?`requestSingleInstanceLock` 骞傜瓑锛氭柊瀹炰緥閫€鍑恒€佹棫绐楀彛鑷姩閲嶈繛锛堝崟瀹炰緥涓庢椿鎬х洃娴嬪崗鍚岋級銆?
**楠岃瘉缁撴灉锛坔eadless 瀹炴祴锛?*锛氱獥鍙?spawn 鉁咃紱浜屾鍚姩鍗曞疄渚?1鈫? 鉁咃紱鏉€鍚庣 鈫?澹冲瓨娲?鉁咃紱閲嶅惎鍚庣 鈫?澹充笉閲嶅寮€銆佺鍙ｆ仮澶?鉁咃紱涓?web profile锛?3120锛夊苟瀛?鉁呫€傝瑙夐」锛堢晫闈?鎵樼洏/绂荤嚎椤?閫氱煡锛夊緟鐢ㄦ埛瀹炴満纭銆?
**棣栬疆瀹炴満鍙嶉淇锛?鏈夌獥鍙ｄ絾鍚庣鏈繛鎺?锛?*锛?- **鏍瑰洜**锛歮ain.cjs 娲绘€ф娴嬪啓鎴?`Promise.race([fetch鈥? Promise.resolve(false)])`鈥斺€旂浜岄」绔嬪埢 resolve锛宺ace 鎭掕繑鍥?`false`锛宖etch 鏄庢槑 200 涔熸案杩滅绾裤€傚睘瀹炵幇 bug锛岄潪鏋舵瀯闂锛?- **淇**锛歚AbortController + setTimeout` 瓒呮椂瀹炵幇锛涚姸鎬佹満鏀?`isOnline`锛屾墭鐩樻枃妗堝悓姝ワ紱绂荤嚎椤?绔嬪嵆閲嶈瘯"鏀逛负瀵艰埅鍒板悗绔?URL锛涙柊澧炶娴嬫棩蹇?`%APPDATA%\dshome-shell\dshome-shell.log`锛堟瘡鏉?fetch/state/load 钀界洏锛屽悗缁帓闅滀笉鐬庣寽锛夛紱
- **瀹屾暣閾捐矾瀹炴祴**锛氭潃鍚庣 鈫?`fetch fail 鈫?state offline`锛堢獥鍙ｅ垏绂荤嚎椤碉級锛涢噸鍚悗绔?鈫?3 绉掑唴 `fetch ok 鈫?state online 鈫?loaded url`锛堢獥鍙ｈ嚜鍔ㄩ噸杩烇級锛涘３淇濇寔鍗曚緥 1銆?- **绗簩鍧戯紙瀹炴満鍙嶉"杩樻槸鍚庣鏈繛鎺?锛夆€斺€旂鍙ｉ粯璁ゅ€?*锛氬畼鏂?webserver 榛樿绔彛鏄?**3080**锛坵eb-app patch `port ?? 3080`锛夛紝鑰屽３鐨勫厹搴曞啓姝讳簡 3081锛涘懡浠よ鏄惧紡 `--port 3081` 鏃朵竴鍒囨甯革紝**瑁歌窇 `dsh --profile dshome` 鍚庣缁?3080銆佺獥鍙ｇ湅 3081锛屽繀鐒剁绾?*銆備慨澶嶏細鎸夊畼鏂?`localWebUrl` 鎬濊矾锛屼粠 **`webServer` 鏈嶅姟璇荤湡瀹炵粦瀹氱鍙?*锛堝彲瑕嗙洊榛樿 / `--port N` / `--port 0` 绯荤粺鍒嗛厤锛夛紝鍏滃簳鏀?3080锛沀RL 鏀瑰湪 spawn 寤舵椂鍥炶皟閲岃В鏋愶紙淇濊瘉宸茬粦瀹氾級銆傛暀璁細绔彛绛夎繍琛屼簨瀹炰竴寰嬩粠鏈嶅姟璇伙紝涓嶇‖缂栫爜銆?
### 15.7 Phase 3 鐨偆/鍝佺墝/閫氱煡/鏁呴殰婕旂粌璁板綍锛?026-08-28锛?
**鈶?dshome-theme 瀹㈡埛绔毊鑲ゅ寘**锛坄E:\DSH\packages\dshome-theme`锛夛細
- 鏈哄埗锛歝lient roster 鏉＄洰 = Loader 琛ヤ竵琛屽紩鐢ㄧ殑鍖?+ 鍖呭唴 `dsh.client` 澹版槑锛坧latform web锛夛紱client.js 浠?`window.__ModuleLoader__.load({id, factory})` 宸ュ巶褰㈡€佹墜鍐欙紙鏃犻渶鏋勫缓绠＄嚎锛夛紝缁?`/plugins/<id>/client.js` 鏈嶅姟锛?- 鐨偆 API锛堝畼鏂癸級锛歚theme.overrideTokens(source, { "--dsw-alias-brand-primary": {light, dark}, ... })`鈥斺€攖oken 鎴愬锛坙ight/dark锛夛紝鍒悕灞傝鐩栧嵆鏃剁敓鏁堬紱
- 鍝佺墝鏇挎崲锛氱鐢?`ui-brand-official` 琛?+ `ctx.slots.register({name:"sidebar.brand.mark|sidebar.brand.name|conversation.hero.brand.mark"}, 缁勪欢)` 娉ㄥ唽 DSHOME 鍝佺墝锛圫VG 鍦嗚鏂瑰潡 + D锛岃摑鑹插彇鑷搧鐗?token锛夛紱
- 瀹炴祴锛歳oster 鍚?`dshome-theme`锛坕d/url/rev锛夛紝`ui-brand-official` 娑堝け锛宑lient.js 200銆傚畼鏂瑰墠绔?token 鍚嶏紙鎻愬彇鑷?dist CSS锛夛細`--dsw-alias-brand-primary`銆乣--dsw-alias-button-primary-fill/-hover`銆乣--dsw-alias-state-business-primary` 绛夛紙鍏ㄩ儴 requiresLightAndDark锛夈€?
**鈶?閫氱煡妗?v1**锛氬３鍐呭湪 32123锛坄DSHOME_NOTIFY_PORT`锛夌洃鍚?POST /notify锛涘湪绾?绂荤嚎鐘舵€佸垏鎹㈡椂澹宠嚜韬脊绯荤粺閫氱煡锛堢偣鍑诲彲鍞よ捣绐楀彛锛夈€傚洖鍚堢粨鏉熺瓑涓氬姟浜嬩欢鐨勬帴绾跨暀 v1.1锛堜簨浠舵簮闇€鍐嶆帰绱級銆?
**鈶?鏁呴殰婕旂粌锛埪?0 楠屾敹椤瑰疄璇侊級**锛?- `--patch drill-bad.yml`锛堟彃鍏ヤ笉瀛樺湪鍖?`dshome-no-such-plugin-package`锛夆啋 鍚姩澶辫触锛屾姤閿欑簿纭埌鍖呭悕锛坄Cannot find package 鈥?imported from <profile>`锛夛紱
- `--patch drill-fix.yml`锛坄- id: dshome-broken; disabled: true`锛夆啋 **姝ｅ父鍚姩**锛?090 鐩戝惉锛夈€傚潖鎻掍欢琛岀骇绂佺敤鍗冲彲鎭㈠锛屾棤闇€鏀逛唬鐮?鍗歌浇锛泈eb profile 涓嶅彈褰卞搷銆?
**鈶?鍏抽敭鏁欒鈥斺€攃lient factory 蹇呴』杩斿洖鎻掍欢鏈綋 + 鏈嶅姟绾?inject**锛?- **绗竴灞?*锛氭祻瑙堝櫒鏉愭枡鍖栨満鍒跺彇鐨勬槸 **`factory(require)` 鐨勮繑鍥炲€?*锛堝畼鏂规枃妗ｅ師鏂?`factory(require) 鈫?exports`锛夛紝瀹樻柟妯″潡缁撳熬閮藉啓 `exports.apply=apply; 鈥? return module.exports;`銆傛棭鏈?dshome-theme client.js 婕忎簡 `return` 鈫?绐楀彛渚?invalid plugin received undefined"锛?- **绗簩灞?*锛氬搧鐗屾Ы娉ㄥ唽杩樿姹傛彃浠?*鏈嶅姟绾ф敞鍏?*锛氬畼鏂瑰搧鐗?`const inject = ["slots"]; exports.inject = inject;`鈥斺€斿彧渚濊禆 `dsh.client.inject`锛堝寘绾т緷璧栵級涓嶅锛宍ctx.slots` 鍦?apply 鍓嶄笉娉ㄥ叆灏变笉鍙敤锛屾姤 `cannot get property "slots"`锛涗竴鍒囩収瀹樻柟 `ctx.slots.inject(...)` 宓屽鐢熸垚鍣ㄦā寮?+ `yield ctx.slots.register(...)` 鎵嶅０鏄庡紡鎴愮珛锛?- 杩欎袱灞傞兘鍙湪**鐪熷疄娴忚鍣ㄨ繍琛屾椂**鏆撮湶锛坔ost 鍚姩/椤甸潰鏈嶅姟/roster 鍏ㄧ豢锛夛紝鎺掗殰闈?**CDP**锛歚electron shell-app --remote-debugging-port=9222` + `cdp-inspect.mjs`/`cdp-verify.mjs`锛堣 DOM 鏂囨湰銆佹姄 console 璀﹀憡銆佺鐢ㄧ紦瀛橀噸杞介獙璇侊級銆俙check-theme-client.mjs` 鏃犲ご鏂█ factory 杩斿洖鍊?+ inject銆?---

## 15.8 主线 A 第一刀（Ctrl+K 命令面板）实施记录（2026-08-29）

- 新增客户端插件 E:\DSH\packages\dshome-palette（dsh.client / CJS node half / 纯 DOM 无 React）；
- 功能：Ctrl+K 弹出覆盖层（dark 语义、品牌蓝）→ ＋ 新建会话 动作 + 会话列表（点会话 → 列出模型分组 → 点模型 → session.selectModel 切模型）；
- 全部走官方 RPC 信封（session.list / session.create / session.models / session.selectModel），与 UI 同通道；
- 挂载：patch 行 dshome-palette + dshome 包 dsh.client.inject 加 dshome-palette；
- 实测：roster 含 dshome-palette、client.js 200、页面 200；CDP 派发 Ctrl+K → 覆盖层 display:flex、渲染 65 行（1 动作 + 63 会话）；
- 会话置顶/收藏为下一刀；调试工具 dshome/cdp-palette.mjs。

### 15.8.1 绗簩鍒€锛氫細璇濈疆椤?鏀惰棌锛?026-08-29锛?
- dshome-palette 鍐呯疆**鏀惰棌锛堚槄 缃《锛?*锛歭ocalStorage dshome.pinned.sessions 鎸佷箙鍖栵紱
- 闈㈡澘椤堕儴"鈽?鏀惰棌浼氳瘽"鍖猴紙缃《浼氳瘽缃《鏄剧ず锛岀偣杩涘彲鍒囨ā鍨嬶級锛屼細璇濊鍙充晶 鈽?鈽?涓€閿敹钘忥紱
- 绾?DOM銆佹棤 React銆佹棤瀹樻柟浼氳瘽鍒楄〃鏀瑰姩锛涗笌涓婚/鍝佺墝/Ctrl+K 闈㈡澘骞跺彂鏃犲啿绐侊紱
- 瀹炴祴锛圕DP锛夛細鐐?鈽?鈫?鏀惰棌鍖哄嚭鐜?+ ls 鍐欏叆 鈫?**鍒锋柊椤甸潰鍚庝粛鍦紙鎸佷箙鍖?鉁擄級** 鈫?鐐?鈽?鍙栨秷鎭㈠锛?- 宸ュ叿锛歞shome/cdp-favs.mjs銆?

### 15.8.2 鏀惰棌鍗囩骇锛氶潰鏉挎爣棰?+ 渚ф爮鍏ュ彛锛?026-08-29锛?
- Ctrl+K 浼氳瘽琛屾敼鐢?*浼氳瘽鏍囬**锛坉isplayTitle / projections.values.title锛夛紝鏃犳爣棰樺洖閫€ sessionId锛?- 浼氳瘽琛?*鐐瑰嚮鍗虫墦寮€**璇ヤ細璇濓紙DOM 涓粙锛氬畾浣嶅畼鏂?ole=treeitem 琛屽惈鏍囬鐨?aria-label 骞?.click()锛涘け璐ュ洖閫€鍒?鍒囨ā鍨?瑙嗗浘锛夛紱
- 渚ф爮**搴曢儴 鈽?鎸夐挳**锛坰idebar.footer.action 鍒楄〃妲斤紝娉ㄥ唽闇€甯?id锛夌偣鍑绘墦寮€鏀惰棌闈㈡澘锛?- 鏋舵瀯绾︽潫璁板綍锛氬畼鏂逛細璇濆垪琛ㄥ尯 sidebar.workspaces 涓?*鍗曟Ы**锛坲i-workspace 鍗犳湁锛屽閮ㄦ敞鍐岃鎷掞級锛屾晠鏀惰棌鐨?瀹屾暣鍒楄〃"淇濈暀鍦?Ctrl+K 闈㈡澘锛屼晶鏍忔斁 鈽?鍏ュ彛锛?- 瀹炴祴锛圕DP锛夛細鏍囬鏄剧ず 鉁撱€佲槄 鏀惰棌鍖?鎸佷箙鍖?鉁撱€乫ooter 鈽?鎸夐挳=1 鉁撱€佹棤 dshome 鍛婅锛涘伐鍏?dshome/cdp-v3.mjs銆乧dp-footer.mjs銆乧dp-console.mjs銆?


### 15.8.3 第三刀：回合级通知 + 设置开关（2026-08-29）
- 目标：当"由你发起的回合"结束（完成/失败）或后台任务结束，DSHOME 弹系统通知；是否提醒由「设置 → 通知」开关控制。
- host 插件 E:\DSH\dshome\lib\host\notify.js（patch 行 dshome/notify，包导出 ./notify）：
  - ctx.settings.register('dshome', z.object({ enabled, notifyOnTurnCompletion }), { applies:'live' }) 注册设置命名空间（客户端设置行读写同一命名空间）；
  - 订阅 sessions.on('session/event')（turn/start、user/message、turn/end）+ jobs.onJobDone，仿官方 dsh-plugin-desktop/notifications 事件接缝；
  - 开关开启且回合为用户发起（非 subagent）时，fetch POST http://127.0.0.1:<DSHOME_NOTIFY_PORT||32123>/notify {title,body} 投递到壳。
- 客户端设置行：在 packages/dshome-theme/lib/client.js 新增 settings.general.item 项（order=20，locale='dshome'），渲染「通知」主开关 + 「回合完成提醒」开关，经 ctx.settingsScope.bind({namespace:'dshome'}) 读写 host 命名空间（store→useStore，inject→setEnabled/setNotifyOnTurnCompletion）。
- 壳侧通知监听由 shell-app/main.cjs startNotifyListener() 提供（POST /notify 读取 {title,body} → Notification.show()）。
- 依赖：@deepseek-ai/schemastery（3.18.1）与 @deepseek-ai/dsh-settings（0.1.1-rc.2）加入 dshome 包 dependencies（开发机以 junction 到 app.src node_modules 解析）。
- 实测：
  - dsh --profile dshome --no-open --port 3081 重启后端，settings.describe 出现 dshome（enabled/notifyOnTurnCompletion=true）；
  - CDP（9222，Network.setCacheDisabled + reload）打开 设置→通用设置→见「通知」两开关；关主开关 → dshome.enabled=false 持久化到 host；再开回 true；
  - 旧壳载入的 main.cjs 早于通知监听、且持单实例锁 → 重启干净壳后 32123 监听 + POST /notify 返回 204（通知链路端到端可用）。
- 工具：dshome/cdp-notify.mjs、probe-rpc.mjs（settings.describe）。
### 15.8.4 插件管理（block 1：已装插件 列表 + 启/停）（2026-08-29）
- 背景：官方「插件列表」纯只读；其 pluginInventory.list 在 DSHOME web profile 404（桌面端 dsh-host-plugin-inventory 未被 web profile 组合）；平台 apiproxy 固定方法集不路由自定义 RPC。
- 方案：用设置命名空间 dshome-pluginmanager 做 宿主↔客户端 数据/指令总线（通知同款机制）。
- host 插件 dshome/lib/host/plugin-manager.js（patch 行 dshome/plugin-manager；inject=['loader']）：
  - 扫描 ctx.loader.entries()（非 group）→ 分类（自制 dshome-* / 内置 @deepseek-ai/* / 其它=下载）→ scope.update({entries}) 推送；
  - 监听 command（request）→ writeToggle 改写 profile cordis.patch.yml（id 定位 disabled:true 增删）→ result {ok,restartNeeded,message}。
- 实测：settings.describe 的 dshome-pluginmanager.value.entries = **144 项**（自制 6：core/shell/theme/palette/notify/plugin-manager；内置 @deepseek-ai/*；下载），每项 entryId/moduleName/enabled/category/phase。
- 备注：启/停每次需重启 profile 生效（Cordis 启动时组合）；客户端 UI（列表+搜索+开关）为下一步；市场/本地自制为后续增量。
- 增补（同批）：核心插件禁停（PROTECTED_MODULES：dshome-* + 应用骨架；客户端"自制"显示"核心"标签、host 返回"核心插件，不可停用"）；profile cordis.patch.yml 顶层为 flow []、writeToggle 须输出块序列（勿混用 flow/block，否则 YAML missed comma）；entryId include:<id> → patch row id <id>（去前缀）。
- 验收（同批）：停 tool-web → - id: tool-web\n  disabled: true（合法块序列），启 → []；禁停 dshome-shell 返回受保护；dshome/core 保持启用。
### 15.8.5 恢复 + Block B 结论 + junction 陷阱（2026-08-29）
- **网络**：npmjs/GitHub/npmmirror/unpkg 均已通（HTTP 200）。
- **Block B**：dsh-community-market **无 dsh.bundle、不是 profile bundle**；进 bundles 会启动失败（已恢复）。正确组合=依赖 + profile cordis.patch.yml 一行插件补丁 - id: community-market\n  name: dsh-community-market。市场浏览/目录纯 web 可用；安装/卸载需桌面 desktopProfiles/desktopPnpm 服务（web profile 无→503）。
- **⚠️ 教训**：Remove-Item -Recurse -Force 作用在 **junction** 上会**顺着删除目标真实内容**（误删 E:\DSH\packages\dshome-theme，已从 DSHOME-PACK-2026-08-29\packages\dshome-theme 还原并从备份包+重放 client.js 的 通知行/插件管理 两处）。删 junction 勿带 -Recurse。
- 当前：DSHOME 3081 正常、144 插件、dshome/core 启用、patch=[]、插件管理+通知行可用；block B 待做。
### 15.8.6 Block B 组合成功 + 官方市场 UI（2026-08-29）
- 组合方式：profile cordis.patch.yml 用 insert（- id: community-market\n  name: dsh-community-market），非 bundle。市场加载成功，/api/community-market/state 200，内置源就绪。
- 官方市场自带启动器 → 「发现/可安装/已安装/来源」UI 可用（浏览/搜索）；安装需桌面 desktopPnpm（web/CLI 提示"需要 DSH Desktop"）。
- 与 block-1 并存：设置模态 [通用设置, 插件管理, 模型, 插件, Agent 预设,…]；插件管理分区正常（139 开关+自制=核心）；市场启动器为独立入口。
- 已撤自建 MarketPanel（冗余），插件管理分区还原为已装列表版。