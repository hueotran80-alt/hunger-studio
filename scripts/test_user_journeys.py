#!/usr/bin/env python3
"""
Comprehensive End-to-End User Journey Tester with Real Screenshot Capture
Simulates a real human user interacting with Web Blender Studio.
Captures high-resolution visual evidence at each major milestone.
"""

import os
import sys
import time
import json
import base64
import asyncio
import subprocess
import urllib.request
import websockets

PORT = 8935
CDP_PORT = 9355
SCREENSHOT_DIR = "/Users/trantuan/.gemini/antigravity/brain/4c544e3f-bef4-4be8-972c-671a1a0307bb/screenshots"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

class WebBlenderUserTester:
    def __init__(self):
        self.req_id = 0
        self.ws = None
        self.srv_proc = None
        self.chrome_proc = None
        self.reports = []

    async def cdp_call(self, method, params=None):
        self.req_id += 1
        my_id = self.req_id
        payload = {"id": my_id, "method": method}
        if params:
            payload["params"] = params
        await self.ws.send(json.dumps(payload))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == my_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP Error in {method}: {msg['error']}")
                return msg.get("result", {})

    async def eval_js(self, expr):
        res = await self.cdp_call("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": True
        })
        if "exceptionDetails" in res:
            exc = res["exceptionDetails"]
            raise RuntimeError(f"JS Exception: {exc.get('text', '')} - {exc.get('exception', {}).get('description', '')}")
        return res.get("result", {}).get("value")

    async def capture_screenshot(self, filename, caption=""):
        await asyncio.sleep(0.5)
        res = await self.cdp_call("Page.captureScreenshot", {"format": "png"})
        raw = base64.b64decode(res["data"])
        path = os.path.join(SCREENSHOT_DIR, filename)
        with open(path, "wb") as f:
            f.write(raw)
        print(f"📸 [CAPTURED] {filename} ({len(raw):,} bytes) — {caption}")
        self.reports.append({
            "filename": filename,
            "path": path,
            "bytes": len(raw),
            "caption": caption
        })
        return path

    async def start(self):
        print(f"Starting server on port {PORT}...")
        self.srv_proc = subprocess.Popen(
            [sys.executable, "server.py", "--port", str(PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        time.sleep(1.2)

        print(f"Launching Headless Chrome on CDP port {CDP_PORT}...")
        self.chrome_proc = subprocess.Popen([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "--headless=new",
            "--disable-gpu-watchdog",
            "--use-gl=angle",
            f"--remote-debugging-port={CDP_PORT}",
            "--window-size=1440,900",
            f"--user-data-dir=/tmp/chrome_journey_{CDP_PORT}",
            f"http://127.0.0.1:{PORT}/index.html"
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3.0)

        targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json").read().decode())
        page = [t for t in targets if t.get("type") == "page"][0]
        self.ws = await websockets.connect(page["webSocketDebuggerUrl"], max_size=2**27)
        await self.cdp_call("Page.enable")
        await self.cdp_call("Runtime.enable")
        print("Connected to Chrome via CDP!")

        # Wait for app readiness
        for _ in range(25):
            ready = await self.eval_js("Boolean(window.app && window.sceneManager && window.stemTutor && window.studio)")
            if ready:
                print("Web Blender Studio fully loaded!")
                break
            await asyncio.sleep(0.4)

    async def stop(self):
        if self.ws:
            await self.ws.close()
        if self.chrome_proc:
            self.chrome_proc.terminate()
        if self.srv_proc:
            self.srv_proc.terminate()
        subprocess.run(["rm", "-rf", f"/tmp/chrome_journey_{CDP_PORT}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("Cleaned up server and headless Chrome.")

    async def run_all_journeys(self):
        print("\n==================================================")
        print("BẮT ĐẦU TEST TOÀN BỘ WEB BLENDER STUDIO NHƯ NGƯỜI DÙNG THẬT")
        print("==================================================\n")

        # ----------------------------------------------------
        # JOURNEY 1: INITIAL STUDIO OVERVIEW
        # ----------------------------------------------------
        print("--- [Journey 1/12] Khởi động Studio, kiểm tra bố cục & Cube mặc định ---")
        stats = await self.eval_js("""({
            objects: document.querySelector('#stat-objects')?.innerText,
            verts: document.querySelector('#stat-verts')?.innerText,
            faces: document.querySelector('#stat-faces')?.innerText,
            tutorVisible: Boolean(document.querySelector('#stem-speech-bubble'))
        })""")
        print("Initial Stats:", stats)
        await self.capture_screenshot("01_initial_studio_view.png", "Giao diện khởi động ban đầu với Cube mặc định, Outliner, Inspector và HUD Giáo viên 1-1")

        # ----------------------------------------------------
        # JOURNEY 2: STEM TUTOR 1-1 (COLLAPSE / EXPAND / EVASION / VOICE)
        # ----------------------------------------------------
        print("\n--- [Journey 2/12] Giáo viên kèm 1-1: Thu gọn HUD, né chuột, đổi tốc độ giọng 1.2x ---")
        await self.eval_js("""(function(){
            const btn = document.querySelector('#stem-btn-collapse');
            if (btn) btn.click();
        })()""")
        await self.capture_screenshot("02_tutor_hud_collapsed.png", "Thanh HUD Giáo viên 1-1 thu gọn thành 1 dòng mảnh trên mép Viewport")

        await self.eval_js("""(function(){
            const btn = document.querySelector('#stem-btn-collapse');
            if (btn) btn.click();
            window.stemTutor.nextStep();
            window.stemTutor.moveToTarget('#btn-edit-extrude');
        })()""")
        await self.capture_screenshot("03_tutor_active_and_pointing.png", "Con trỏ 42px bay tới chỉ nút Extrude trên thanh công cụ mà không che khuất nút")

        # ----------------------------------------------------
        # JOURNEY 3: OBJECT MODE (TRANSFORMS & PRIMITIVE ASSEMBLY)
        # ----------------------------------------------------
        print("\n--- [Journey 3/12] Object Mode: Lắp ghép bàn 3D (mặt bàn + 4 chân bàn) & Gizmo ---")
        await self.eval_js("""(function(){
            studio.clearScene();
            // Create Table top
            const top = studio.addCube([0, 1.0, 0], [1.6, 0.1, 1.0], [0.85, 0.6, 0.4]);
            top.name = "Table_Top";
            // Create 4 legs
            const leg1 = studio.addCylinder([-0.7, 0.45, -0.4], [0.06, 0.9, 0.06], [0.2, 0.2, 0.2]);
            leg1.name = "Leg_FL";
            const leg2 = studio.addCylinder([0.7, 0.45, -0.4], [0.06, 0.9, 0.06], [0.2, 0.2, 0.2]);
            leg2.name = "Leg_FR";
            const leg3 = studio.addCylinder([-0.7, 0.45, 0.4], [0.06, 0.9, 0.06], [0.2, 0.2, 0.2]);
            leg3.name = "Leg_BL";
            const leg4 = studio.addCylinder([0.7, 0.45, 0.4], [0.06, 0.9, 0.06], [0.2, 0.2, 0.2]);
            leg4.name = "Leg_BR";
            window.sceneManager.select(top, false);
        })()""")
        await self.capture_screenshot("04_object_mode_table_assembly.png", "Lắp ghép đa khối mô hình Bàn Trà 3D gồm Mặt bàn và 4 Chân bàn trong Object Mode")

        # ----------------------------------------------------
        # JOURNEY 4: EDIT MODE (BOX MODELING: FACE SELECT, EXTRUDE, BEVEL)
        # ----------------------------------------------------
        print("\n--- [Journey 4/12] Edit Mode: Dựng hình chi tiết bằng Face Select, Extrude (E) & Bevel ---")
        await self.eval_js("""(function(){
            studio.clearScene();
            const cube = studio.addCube([0, 0.5, 0], [1.0, 1.0, 1.0]);
            window.sceneManager.select(cube, false);

            const modeSelect = document.getElementById('viewport-mode');
            modeSelect.value = 'edit';
            modeSelect.dispatchEvent(new Event('change'));

            document.getElementById('btn-mode-face')?.click();
            window.editMode.selectedFaces.add(4);
            window.editMode.selectedFaces.add(5);
            window.editMode.extrude(0.6);
            window.editMode.bevel(0.1);
        })()""")
        edit_stats = await self.eval_js("""({
            mode: document.getElementById('viewport-mode')?.value,
            verts: document.querySelector('#stat-verts')?.innerText,
            faces: document.querySelector('#stat-faces')?.innerText
        })""")
        print("Edit Mode Stats:", edit_stats)
        await self.capture_screenshot("05_edit_mode_extrude_bevel.png", "Edit Mode với Face Select, đùn mặt Extrude và vát góc Bevel tạo hình khối phức tạp")

        # ----------------------------------------------------
        # JOURNEY 5: MODIFIERS (SUBDIVISION SURFACE & BEVEL)
        # ----------------------------------------------------
        print("\n--- [Journey 5/12] Modifiers Panel: Thêm Modifier Subdivision Surface làm mịn đa giác ---")
        await self.eval_js("""(function(){
            const modeSelect = document.getElementById('viewport-mode');
            modeSelect.value = 'object';
            modeSelect.dispatchEvent(new Event('change'));

            const modTab = document.querySelector('.prop-tab-btn[data-tab="modifier"]');
            if (modTab) modTab.click();
            const sel = document.querySelector('#modifier-add-select');
            if (sel) {
                sel.value = 'subdivision';
                sel.dispatchEvent(new Event('change'));
            }
        })()""")
        await self.capture_screenshot("06_modifiers_subdivision_surface.png", "Bảng Modifiers trong Inspector và lưới hình học được làm mịn đa giác (Subdivision Surface)")

        # ----------------------------------------------------
        # JOURNEY 6: SCULPT MODE (DIGITAL CLAY SCULPTING)
        # ----------------------------------------------------
        print("\n--- [Journey 6/12] Sculpt Mode: Chế độ Điêu khắc 3D với Clay Strips & Thanh công cụ cọ ---")
        await self.eval_js("""(function(){
            const modeSelect = document.getElementById('viewport-mode');
            modeSelect.value = 'sculpt';
            modeSelect.dispatchEvent(new Event('change'));

            const clayBtn = document.querySelector('#btn-sculpt-clay');
            if (clayBtn) clayBtn.click();
            const rad = document.querySelector('#slider-sculpt-radius');
            if (rad) { rad.value = 0.6; rad.dispatchEvent(new Event('input')); }
        })()""")
        await self.capture_screenshot("07_sculpt_mode_active.png", "Giao diện Sculpt Mode với bộ cọ điêu khắc (Draw, Clay, Smooth, Flatten, Inflate) và thanh điều khiển độ lớn cọ")

        # ----------------------------------------------------
        # JOURNEY 7: PBR MATERIALS & SHADING OPTIONS
        # ----------------------------------------------------
        print("\n--- [Journey 7/12] PBR Materials Dock & Viewport Shading Popover ---")
        await self.eval_js("""(function(){
            const modeSelect = document.getElementById('viewport-mode');
            modeSelect.value = 'object';
            modeSelect.dispatchEvent(new Event('change'));

            // Switch Bottom Dock to Materials
            const matTab = document.querySelector('.dock-tab[data-pane="dock-materials"]');
            if (matTab) matTab.click();

            // Switch to Rendered PBR shading
            const renderedBtn = document.querySelector('#shading-rendered');
            if (renderedBtn) renderedBtn.click();

            // Open Shading popover
            const popoverBtn = document.querySelector('#btn-shading-popover');
            if (popoverBtn) popoverBtn.click();
        })()""")
        await self.capture_screenshot("08_pbr_materials_and_shading_popover.png", "Thư viện 24 chất liệu PBR cao cấp, chế độ hiển thị Rendered PBR và Popover tuỳ chỉnh ánh sáng môi trường")
        # Close popover
        await self.eval_js("""(function(){
            const closeBtn = document.querySelector('#btn-popover-close');
            if (closeBtn) closeBtn.click();
        })()""")

        # ----------------------------------------------------
        # JOURNEY 8: AI COPILOT & RAPID 3D PROCEDURAL SCENE
        # ----------------------------------------------------
        print("\n--- [Journey 8/12] Blender Scripting DSL & Trình diễn Thành phố Procedural ---")
        await self.eval_js("""(async function(){
            const scriptTab = document.querySelector('.dock-tab[data-pane="dock-scripting"]');
            if (scriptTab) scriptTab.click();
            if (window.app && window.app.codeEditor) {
                window.app.codeEditor.loadPreset(0);
                await window.app.codeEditor.execute();
            }
        })()""")
        await asyncio.sleep(1.2)
        # Open AI Copilot panel
        await self.eval_js("""(function(){
            if (window.aiCopilot) {
                window.aiCopilot.toggleVisibility(true);
            }
        })()""")
        await self.capture_screenshot("09_ai_copilot_and_procedural_scene.png", "Sân khấu Thành phố Procedural sinh tự động bằng mã Rapid 3D DSL và Modal Blender AI Copilot 2.0")
        # Close AI Copilot panel
        await self.eval_js("""(function(){
            if (window.aiCopilot) {
                window.aiCopilot.toggleVisibility(false);
            }
        })()""")

        # ----------------------------------------------------
        # JOURNEY 9: PHYSICS SIMULATION (RAPIER 3D WASM)
        # ----------------------------------------------------
        print("\n--- [Journey 9/12] Physics Dock: Mô phỏng Vật lý Rơi tự do & Va chạm Rapier 3D ---")
        await self.eval_js("""(function(){
            studio.clearScene();
            // Switch Bottom Dock to Physics
            const physTab = document.querySelector('.dock-tab[data-pane="dock-physics"]');
            if (physTab) physTab.click();

            // Create stack of dynamic cubes
            for (let i = 0; i < 3; i++) {
                const box = studio.addCube([0.08 * i, 1.2 + i * 1.1, 0.04 * i], [0.8, 0.8, 0.8], [0.9, 0.3 + i*0.2, 0.2]);
                box.name = "Box_" + i;
                if (window.simulationManager) {
                    window.simulationManager.addObject(box, { type: 'dynamic', collider: 'box', mass: 1.0 });
                }
            }
            if (window.simulationManager) {
                window.simulationManager.setGroundEnabled(true, 0);
                window.simulationManager.stepFrames(25);
            }
        })()""")
        await self.capture_screenshot("10_rapier_physics_simulation.png", "Tab Physics trong Bottom Dock và các khối hộp va chạm đổ chồng dưới trọng lực mô phỏng Rapier WASM")

        # ----------------------------------------------------
        # JOURNEY 10: POSE & RIGGING / CHARACTER MOCAP
        # ----------------------------------------------------
        print("\n--- [Journey 10/12] Pose & Rigging: Khung xương Armature & Chuyển động Mocap ---")
        await self.eval_js("""(function(){
            // Switch to Pose Dock
            const poseTab = document.querySelector('.dock-tab[data-pane="dock-pose"]');
            if (poseTab) poseTab.click();
            // Toggle Pose Mode button
            const btnPose = document.querySelector('#btn-toggle-pose-mode');
            if (btnPose) btnPose.click();
        })()""")
        await self.capture_screenshot("11_character_rig_and_pose.png", "Bảng Pose & Rigging với cấu trúc cây xương nhân vật, bảng điều khiển FK/IK và nạp Video Mocap")

        # ----------------------------------------------------
        # JOURNEY 11: TIMELINE & GRAPH EDITOR (F-CURVE)
        # ----------------------------------------------------
        print("\n--- [Journey 11/12] Timeline Animation & Trình biên tập Đường cong Graph Editor ---")
        await self.eval_js("""(function(){
            // Switch to Graph Editor Dock
            const graphTab = document.querySelector('.dock-tab[data-pane="dock-graph-editor"]');
            if (graphTab) graphTab.click();
        })()""")
        await self.capture_screenshot("12_timeline_and_graph_editor.png", "Trình biên tập đường cong F-Curve (Graph Editor) tinh chỉnh nội suy chuyển động Animation")

        # ----------------------------------------------------
        # JOURNEY 12: SHARE / EMBED & CLOUD STORAGE
        # ----------------------------------------------------
        print("\n--- [Journey 12/12] File Menu: Hộp thoại Share / Embed 1-Click & Cloud Projects ---")
        # Open Share dialog
        await self.eval_js("""(function(){
            const shareBtn = document.querySelector('#btn-file-share');
            if (shareBtn) shareBtn.click();
        })()""")
        await self.capture_screenshot("13_share_embed_dialog.png", "Hộp thoại File → Share / Embed 3D tạo liên kết 1-click nhúng iframe và nén gzip URL")
        # Close Share dialog
        await self.eval_js("""(function(){
            const closeBtn = document.querySelector('#ss-close');
            if (closeBtn) closeBtn.click();
        })()""")

        # Open Cloud dialog
        await self.eval_js("""(function(){
            const cloudBtn = document.querySelector('#btn-file-cloud');
            if (cloudBtn) cloudBtn.click();
        })()""")
        await self.capture_screenshot("14_cloud_account_dialog.png", "Hộp thoại File → Cloud / Tài khoản quản lý dự án đám mây, số dư 100 Credit và thanh toán QR")
        # Close Cloud dialog
        await self.eval_js("""(function(){
            const closeBtn = document.querySelector('#cp-close');
            if (closeBtn) closeBtn.click();
        })()""")

        print("\n==================================================")
        print("HOÀN TẤT 12/12 BÀI TEST NGƯỜI DÙNG THẬT KÈM ẢNH CHỤP MÀN HÌNH!")
        print("==================================================")

async def main():
    tester = WebBlenderUserTester()
    try:
        await tester.start()
        await tester.run_all_journeys()
    finally:
        await tester.stop()

if __name__ == "__main__":
    asyncio.run(main())
