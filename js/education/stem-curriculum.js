/**
 * Web Blender Studio — Giai đoạn 4.1 (Nâng cấp Toàn diện):
 * Hệ thống Giáo trình Dựng Mô hình 3D Thực chiến & Giáo viên AI Kèm 1-1
 *
 * Bao gồm:
 *  1. 6 Bài học Dựng hình 3D Thực chiến (Object Mode Assembly -> Edit Mode Box Modeling Extrude/Inset/Bevel
 *     -> Modifiers & CSG Boolean -> Sculpting & PBR Studio -> Rigging, Pose & AI Mocap -> AI Copilot, Physics & Xuất GLB).
 *  2. Auto-Grader Hình học 3D (Geometry & Topology Inspector): chấm điểm trực tiếp trên lưới đa giác
 *     (số đỉnh, số mặt, BoundingBox, biến dạng Edit/Sculpt, Modifier Stack, PBR, Rig/Animation, Physics).
 *  3. Toán học Định vị Con trỏ Giáo viên Không Chắn Giao diện (Zero-Overlap + Cursor Evasion).
 *  4. Engine Giọng nói Neural Tiếng Việt Tốc độ cao (/api/tts Pre-fetch Cache + Tốc độ 1.2x + Fallback mượt).
 */

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Thu thập danh sách các đối tượng người dùng trong cảnh 3D (loại bỏ hệ thống/helper).
 */
export function collectUserSceneObjects(sceneManager) {
  if (!sceneManager) return [];
  const out = [];
  if (typeof sceneManager.traverseObjects === 'function') {
    sceneManager.traverseObjects((obj) => {
      if (!obj || obj === sceneManager.rootContainer) return;
      if (obj.userData?.isSystemObject || obj.userData?.isHelper || obj.userData?.isLightHelper || obj.userData?.isCameraPart) return;
      if (obj.isBone || obj.type === 'Bone') return;
      out.push(obj);
    });
  } else if (sceneManager.objects instanceof Map) {
    for (const obj of sceneManager.objects.values()) {
      if (!obj || obj.userData?.isSystemObject || obj.userData?.isHelper) continue;
      out.push(obj);
    }
  } else if (Array.isArray(sceneManager)) {
    return sceneManager.filter(o => o && !o.userData?.isSystemObject && !o.userData?.isHelper);
  }
  return out;
}

/**
 * Lấy màu hex (#rrggbb) của vật liệu đầu tiên trên một đối tượng Mesh.
 */
export function getMeshColorHex(obj) {
  if (!obj) return null;
  const mat = obj.userData?.__originalMaterial || obj.material;
  const first = Array.isArray(mat) ? mat[0] : mat;
  if (!first || !first.color) return null;
  if (typeof first.color.getHexString === 'function') {
    return `#${first.color.getHexString().toLowerCase()}`;
  }
  if (typeof first.color === 'number') {
    return `#${first.color.toString(16).padStart(6, '0').toLowerCase()}`;
  }
  return null;
}

/**
 * Lấy thông số vật liệu (roughness, metalness, emissiveIntensity) của Mesh.
 */
export function getMeshMaterialProps(obj) {
  const mat = obj?.userData?.__originalMaterial || obj?.material;
  const first = Array.isArray(mat) ? mat[0] : mat;
  if (!first) return { roughness: null, metalness: null, emissiveIntensity: 0, isDefaultClay: true };
  return {
    roughness: typeof first.roughness === 'number' ? first.roughness : null,
    metalness: typeof first.metalness === 'number' ? first.metalness : null,
    emissiveIntensity: typeof first.emissiveIntensity === 'number' ? first.emissiveIntensity : 0,
    isDefaultClay: !!first.userData?.isDefaultClay
  };
}

/**
 * Đo thông số hình học & cấu trúc lưới đa giác (Topology) của một đối tượng Mesh.
 */
export function getMeshTopologyStats(mesh) {
  if (!mesh || !mesh.geometry) {
    return {
      vertexCount: 0,
      triangleCount: 0,
      modifierCount: 0,
      isExtrudedOrEdited: false,
      dimensions: { x: 1, y: 1, z: 1 },
      aspectVariety: 1
    };
  }
  const geom = mesh.geometry;
  const posAttr = geom.attributes?.position;
  const vertexCount = posAttr ? Number(posAttr.count) || 0 : (Number(geom.vertexCount) || 0);
  const indexCount = geom.index ? Number(geom.index.count) || 0 : vertexCount;
  const triangleCount = Math.floor(indexCount / 3);
  const modifierStack = Array.isArray(mesh.userData?.modifierStack) ? mesh.userData.modifierStack : [];
  const modifierCount = modifierStack.filter(m => m && m.enabled !== false).length;

  let dx = Math.abs((mesh.scale?.x ?? 1) * (geom.parameters?.width ?? (geom.parameters?.radius ? geom.parameters.radius * 2 : 2)));
  let dy = Math.abs((mesh.scale?.y ?? 1) * (geom.parameters?.height ?? (geom.parameters?.radius ? geom.parameters.radius * 2 : 2)));
  let dz = Math.abs((mesh.scale?.z ?? 1) * (geom.parameters?.depth ?? (geom.parameters?.radius ? geom.parameters.radius * 2 : 2)));

  if (posAttr && typeof posAttr.getX === 'function' && posAttr.count >= 3) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    const step = Math.max(1, Math.floor(posAttr.count / 120));
    for (let i = 0; i < posAttr.count; i += step) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (Number.isFinite(minX) && maxX > minX) dx = (maxX - minX) * Math.abs(mesh.scale?.x ?? 1);
    if (Number.isFinite(minY) && maxY > minY) dy = (maxY - minY) * Math.abs(mesh.scale?.y ?? 1);
    if (Number.isFinite(minZ) && maxZ > minZ) dz = (maxZ - minZ) * Math.abs(mesh.scale?.z ?? 1);
  }

  const maxDim = Math.max(dx, dy, dz, 0.001);
  const minDim = Math.max(Math.min(dx, dy, dz), 0.001);
  const aspectVariety = maxDim / minDim;

  // Khối Cube mặc định có 24 đỉnh (12 tam giác). Nếu đã Extrude, Inset, Bevel, Subdivide hoặc Boolean thì số đỉnh > 24
  const isCubePrimitive = mesh.userData?.primitiveType === 'cube' || /BoxGeometry/i.test(geom.type || '');
  const isExtrudedOrEdited =
    !!mesh.userData?.editedInEditMode ||
    !!mesh.userData?.sculpted ||
    !!mesh.userData?.booleanOp ||
    modifierCount > 0 ||
    (isCubePrimitive && vertexCount > 24) ||
    (!isCubePrimitive && vertexCount > 36);

  return {
    vertexCount,
    triangleCount,
    modifierCount,
    isExtrudedOrEdited,
    dimensions: {
      x: Number(dx.toFixed(2)),
      y: Number(dy.toFixed(2)),
      z: Number(dz.toFixed(2))
    },
    aspectVariety: Number(aspectVariety.toFixed(2))
  };
}

/**
 * Tóm tắt toàn bộ trạng thái cảnh 3D hiện tại để cung cấp cho AI Giáo viên 1-1 & Auto-Grader.
 */
export function inspectSceneGeometrySummary(sceneManager, editMode = null) {
  const objects = collectUserSceneObjects(sceneManager);
  const meshes = objects.filter(o => o && (o.isMesh || o.type === 'Mesh' || o.geometry));
  const lights = objects.filter(o => o && (o.isLight || /Light$/i.test(o.type || '') || o.userData?.isStudioLight));
  const skinnedMeshes = objects.filter(o => o && (o.isSkinnedMesh || o.skeleton));

  let totalVertices = 0;
  let totalTriangles = 0;
  let totalModifiers = 0;
  let editedMeshCount = 0;

  const meshSummaries = meshes.slice(0, 20).map((m) => {
    const topo = getMeshTopologyStats(m);
    totalVertices += topo.vertexCount;
    totalTriangles += topo.triangleCount;
    totalModifiers += topo.modifierCount;
    if (topo.isExtrudedOrEdited) editedMeshCount++;
    const matProps = getMeshMaterialProps(m);
    return {
      name: m.name || 'Mesh',
      type: m.userData?.primitiveType || m.geometry?.type || 'Mesh',
      position: {
        x: Number((m.position?.x || 0).toFixed(2)),
        y: Number((m.position?.y || 0).toFixed(2)),
        z: Number((m.position?.z || 0).toFixed(2))
      },
      scale: {
        x: Number((m.scale?.x ?? 1).toFixed(2)),
        y: Number((m.scale?.y ?? 1).toFixed(2)),
        z: Number((m.scale?.z ?? 1).toFixed(2))
      },
      vertexCount: topo.vertexCount,
      triangleCount: topo.triangleCount,
      dimensions: topo.dimensions,
      modifiers: (m.userData?.modifierStack || []).map(mod => mod.type),
      color: getMeshColorHex(m),
      metalness: matProps.metalness,
      roughness: matProps.roughness,
      isEdited: topo.isExtrudedOrEdited,
      hasPhysics: !!m.userData?.physics?.enabled
    };
  });

  const activeObj = typeof sceneManager?.getActiveObject === 'function'
    ? sceneManager.getActiveObject()
    : (sceneManager?.activeObject || sceneManager?.selectedObject || null);

  const viewportModeEl = typeof document !== 'undefined' ? document.getElementById('viewport-mode') : null;
  const activeMode = editMode?.isActive
    ? 'edit'
    : (viewportModeEl?.value || 'object');

  return {
    activeMode,
    editSelectionMode: editMode?.selectionMode || null,
    objectCount: objects.length,
    meshCount: meshes.length,
    lightCount: lights.length,
    skinnedMeshCount: skinnedMeshes.length,
    totalVertices,
    totalTriangles,
    totalModifiers,
    editedMeshCount,
    selectedObject: activeObj ? {
      name: activeObj.name || 'Selected',
      type: activeObj.userData?.primitiveType || activeObj.type || 'Object3D',
      topology: activeObj.isMesh ? getMeshTopologyStats(activeObj) : null
    } : null,
    meshes: meshSummaries
  };
}

// ============================================================================
// DANH MỤC 6 BÀI HỌC DỰNG HÌNH 3D THỰC CHIẾN (3D MODELING CURRICULUM)
// ============================================================================

export const STEM_LESSONS = [
  {
    id: 'lesson-01-primitives',
    number: 1,
    title: 'Bài 1: Làm chủ Object Mode & Lắp ráp Mô hình 3D (G / R / S)',
    level: 'Cơ bản · Dựng hình',
    durationMinutes: 10,
    xp: 100,
    summary: 'Học cách thêm các khối nguyên bản (Cube, Cylinder, Sphere) từ menu Add (Shift+A) và dùng công cụ Move (G), Rotate (R), Scale (S), Duplicate (Shift+D) để lắp ghép mô hình Bàn Ghế, Cây Cối hoặc Robot 3D.',
    objectives: [
      'Thêm ít nhất 2–3 khối 3D (Cube, Sphere, Cylinder...) từ menu Add (Shift+A) hoặc thanh công cụ trái',
      'Sử dụng công cụ Move (G) và Scale (S) để biến đổi tỷ lệ và sắp xếp các bộ phận trên mặt sàn (Y >= 0.45)',
      'Đặt các bộ phận ở vị trí hợp lý (không bị trùng khít tọa độ lên nhau)'
    ],
    starterCode: `// BÀI 1: LẮP RÁP MÔ HÌNH 3D TRONG OBJECT MODE (BÀN TRÀ & ĐÈN CẦU)
// Cách 1 (Trực quan): Dùng menu "Add" (Shift+A) + công cụ Move (G), Scale (S) trên giao diện!
// Cách 2 (Rapid DSL): Bấm "Chạy (Ctrl+Enter)" đoạn mã lắp ghép dưới đây:
studio.clearScene();

// 1. Khối bàn trung tâm
studio.addCube({
  name: "Mat_Ban_3D",
  x: -1.8, y: 1.0, z: 0,
  width: 2.2, height: 1.4, depth: 1.6,
  color: 0x3498db
});

// TODO: Hãy thêm một khối cầu (Add -> UV Sphere hoặc studio.addSphere) ở tọa độ x = 1.8, y = 1.0!
`,
    solutionCode: `// MẪU THỰC HÀNH BÀI 1: LẮP RÁP BỘ BÀN & QUẢ CẦU TRANG TRÍ 3D
studio.clearScene();

// 1. Thân bàn khối hộp
studio.addCube({
  name: "Khoi_Ban_Lap_Phuong",
  x: -1.8, y: 1.0, z: 0,
  width: 2.2, height: 1.6, depth: 1.8,
  color: 0x3498db
});

// 2. Quả cầu trang trí đặt bên cạnh
studio.addSphere({
  name: "Qua_Cau_Trang_Tri",
  x: 1.8, y: 1.0, z: 0,
  radius: 1.0,
  color: 0xe74c3c
});

// 3. Trụ đỡ bổ trợ
studio.addCylinder({
  name: "Tru_Do_3D",
  x: 0, y: 0.8, z: -1.8,
  radiusTop: 0.5, radiusBottom: 0.6, height: 1.6,
  color: 0x2ecc71
});

print("✓ Đã lắp ráp xong tổ hợp khối 3D trên mặt sàn!");
`,
    steps: [
      {
        title: 'Bước 1: Điều hướng khung nhìn 3D (chuột giữa + Numpad)',
        targetSelector: '#viewport-canvas-host',
        panel: null,
        voiceText: 'Chuẩn Blender trước tiên là điều hướng: giữ chuột giữa để xoay góc nhìn, Shift cộng chuột giữa để dời khung nhìn, và lăn chuột để phóng to thu nhỏ. Bạn cũng có thể bấm Numpad 1, 3, 7 để nhìn thẳng góc Trước, Phải, Trên và Numpad 5 để đổi phối cảnh sang song song.',
        actionHint: 'Xoay / dời / zoom khung nhìn bằng chuột giữa hoặc các phím Numpad 1/3/7/5.',
        expectedAction: 'navigate_view'
      },
      {
        title: 'Bước 2: Thêm khối 3D mới (Menu Add / Shift+A)',
        targetSelector: '#menu-add',
        panel: null,
        voiceText: 'Chào bạn! Để bắt đầu dựng mô hình 3D, bạn hãy bấm vào menu Add ở góc trên bên trái hoặc nhấn tổ hợp phím Shift A, sau đó chọn Cube, Cylinder hoặc UV Sphere.',
        actionHint: 'Bấm menu Add (hoặc nút Add Cube ở thanh công cụ trái) để thêm khối 3D.',
        expectedAction: 'add_mesh'
      },
      {
        title: 'Bước 3: Di chuyển (G) & Co giãn tỷ lệ (S)',
        targetSelector: '#tool-move',
        panel: null,
        voiceText: 'Tiếp theo, bạn dùng công cụ Move phím tắt G để kéo các khối ra hai vị trí khác nhau trên mặt sàn, và dùng công cụ Scale phím tắt S ngay bên dưới để chỉnh độ dày mỏng như mặt bàn hay chân ghế.',
        actionHint: 'Dùng công cụ Move (G) và Scale (S) ở thanh công cụ bên trái để sắp xếp mô hình.',
        expectedAction: 'transform_mesh'
      },
      {
        title: 'Bước 4: Nhân bản nhanh (Shift+D) & Quản lý Outliner',
        targetSelector: '#outliner-panel',
        panel: null,
        voiceText: 'Mẹo dựng hình nhanh: Bạn có thể nhấn Shift D để nhân bản một bộ phận đã chỉnh sẵn tỷ lệ. Nhìn sang bảng Outliner bên phải để kiểm tra danh sách các bộ phận, rồi bấm Chấm điểm nhé!',
        actionHint: 'Đảm bảo có ít nhất 2 khối 3D (Cube & Sphere hoặc các bộ phận lắp ghép) tách rời nhau trên sàn.',
        expectedAction: 'add_mesh'
      }
    ],
    rubric: [
      {
        id: 'min-two-meshes',
        label: 'Có ít nhất 2 khối Mesh 3D trong cảnh để lắp ghép',
        points: 30,
        hint: 'Vào menu Add -> thêm ít nhất 2 khối 3D (ví dụ Cube, Sphere, Cylinder).',
        check: ({ meshes }) => {
          const ok = meshes.length >= 2;
          return {
            passed: ok,
            feedback: ok
              ? `Đã có ${meshes.length} khối Mesh 3D trong cảnh.`
              : `Hiện mới có ${meshes.length} khối. Hãy vào menu Add (Shift+A) thêm ít nhất 2 khối 3D nhé!`
          };
        }
      },
      {
        id: 'has-cube-and-sphere',
        label: 'Đa dạng hình khối (Cube + Sphere/Cylinder) hoặc đã Scale biến đổi tỷ lệ bộ phận',
        points: 30,
        hint: 'Thêm cả khối hộp (Cube) và khối cầu (Sphere)/trụ (Cylinder), hoặc dùng công cụ Scale (S) chỉnh tỷ lệ khối.',
        check: ({ meshes, code }) => {
          const hasBox = meshes.some(m => /box/i.test(m.geometry?.type || '') || m.userData?.primitiveType === 'cube') || /addCube/i.test(code);
          const hasOther = meshes.some(m => /(sphere|cylinder|cone|torus)/i.test(m.geometry?.type || '') || /(sphere|cylinder|cone|torus)/i.test(m.userData?.primitiveType || '')) || /(addSphere|addCylinder|addCone|addTorus)/i.test(code);
          const hasScaledPart = meshes.some(m => {
            const topo = getMeshTopologyStats(m);
            const sx = m.scale?.x ?? 1, sy = m.scale?.y ?? 1, sz = m.scale?.z ?? 1;
            const scaled = Math.abs(sx - sy) > 0.15 || Math.abs(sy - sz) > 0.15 || Math.abs(sx - 1) > 0.15;
            return scaled || topo.aspectVariety >= 1.35 || topo.isExtrudedOrEdited;
          });
          const ok = meshes.length >= 2 && ((hasBox && hasOther) || hasScaledPart || meshes.length >= 3);
          return {
            passed: ok,
            feedback: ok
              ? 'Các bộ phận 3D đã có sự đa dạng về hình khối và tỷ lệ.'
              : 'Hãy thêm khối Sphere/Cylinder kết hợp với Cube, hoặc dùng công cụ Scale (S) biến đổi tỷ lệ khối!'
          };
        }
      },
      {
        id: 'above-ground',
        label: 'Các bộ phận được đặt chuẩn trên mặt sàn (Y >= 0.45)',
        points: 20,
        hint: 'Kéo trục Y (mũi tên xanh lá) lên trên mặt sàn để Y >= 0.5.',
        check: ({ meshes }) => {
          const ok = meshes.length >= 2 && meshes.every(m => (m.position?.y ?? 0) >= 0.45);
          return {
            passed: ok,
            feedback: ok
              ? 'Tất cả bộ phận đều nằm chuẩn phía trên mặt sàn.'
              : 'Có khối đang bị chìm dưới mặt sàn (Y < 0.45). Hãy dùng Move (G) kéo khối lên cao hơn!'
          };
        }
      },
      {
        id: 'separated-positions',
        label: 'Các khối được bố trí tách biệt trong không gian (không trùng khít tọa độ)',
        points: 20,
        hint: 'Dùng công cụ Move (G) kéo các khối cách nhau ít nhất 1.2m.',
        check: ({ meshes }) => {
          if (meshes.length < 2) return { passed: false, feedback: 'Cần ít nhất 2 khối để kiểm tra bố cục không gian.' };
          let maxDist = 0;
          for (let i = 0; i < meshes.length; i++) {
            for (let j = i + 1; j < meshes.length; j++) {
              const a = meshes[i].position || { x: 0, y: 0, z: 0 };
              const b = meshes[j].position || { x: 0, y: 0, z: 0 };
              const d = Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
              if (d > maxDist) maxDist = d;
            }
          }
          const ok = maxDist >= 1.2;
          return {
            passed: ok,
            feedback: ok
              ? `Bố cục không gian rõ ràng (khoảng cách giữa các bộ phận đạt ${maxDist.toFixed(2)}m).`
              : `Các khối đang bị trùng vị trí (${maxDist.toFixed(2)}m). Hãy dùng Move (G) kéo tách chúng ra nhé!`
          };
        }
      }
    ]
  },

  {
    id: 'lesson-02-materials-lights',
    number: 2,
    title: 'Bài 2: Edit Mode Box Modeling (Extrude / Inset / Bevel) & Vật liệu PBR',
    level: 'Cơ bản · Đa giác & PBR',
    durationMinutes: 15,
    xp: 130,
    summary: 'Kỹ năng cốt lõi của người dựng hình 3D: Chuyển sang Edit Mode (Tab), chọn Mặt (Face - phím 3), dùng Extrude (E) đùn khối, Inset (I) thu viền, Bevel vát cạnh (Ctrl+B trong Blender), sau đó phủ Vật liệu PBR Kim loại và bật Đèn Studio.',
    objectives: [
      'Chuyển sang Edit Mode (Tab) để đẩy mặt đa giác bằng Extrude (E) / Inset (I) / Bevel (B) HOẶC tạo hình khối chi tiết',
      'Gán Vật liệu PBR Kim loại bóng (metalness >= 0.6, roughness <= 0.4) từ kệ PBR Materials hoặc Inspector',
      'Thêm ít nhất 1 nguồn sáng (Point/Sun/Spot Light) để làm nổi bật khối vát cạnh'
    ],
    starterCode: `// BÀI 2: BOX MODELING ĐA GIÁC (EXTRUDE / INSET) & VẬT LIỆU PBR KIM LOẠI
// Cách 1 (Dựng trực tiếp trên Viewport):
//   1. Chọn khối 3D -> Đổi "Object Mode" sang "Edit Mode" (phím Tab).
//   2. Bấm nút "Face Select (3)" -> Click chọn mặt trên của khối -> Bấm "Inset (I)" rồi "Extrude (E)".
//   3. Mở kệ "PBR Materials" gán vật liệu kim loại và thêm đèn từ menu "Add -> Point Light".
// Cách 2 (Chạy script kết hợp API dựng hình dưới đây):
studio.clearScene();

const tower = studio.addCube({
  name: "Thap_Co_Ban",
  x: 0, y: 1.0, z: 0,
  width: 2.0, height: 2.0, depth: 2.0
});

// TODO: Chọn khối -> vào Edit Mode (Tab), bấm Inset (I) / Extrude (E),
// gán vật liệu PBR kim loại (metalness >= 0.6, roughness <= 0.4) và thêm 1 đèn studio.addLight(...)!
`,
    solutionCode: `// MẪU THỰC HÀNH BÀI 2: DỰNG KHỐI ĐA GIÁC EDIT MODE + PBR KIM LOẠI + ĐÈN STUDIO
studio.clearScene();

const mesh = studio.addCube({
  name: "Khoi_Co_Khi_Extrude",
  x: -1.4, y: 1.0, z: 0,
  width: 2.0, height: 2.0, depth: 2.0,
  color: 0xf1c40f,
  metalness: 0.9,
  roughness: 0.16
});

// Thực hiện Box Modeling: vào Edit Mode, chọn mặt đỉnh và Inset + Extrude tạo tháp bậc thang
if (window.editMode && typeof window.editMode.enter === 'function') {
  window.editMode.enter(mesh);
  window.editMode.setMode('face');
  if (window.editMode.faces && window.editMode.faces.length > 0) {
    // Tìm mặt hướng lên trên (normal.y > 0.7)
    let topFaceIdx = 0;
    window.editMode.faces.forEach((f, idx) => {
      if (f.normal && f.normal.y > 0.7) topFaceIdx = idx;
    });
    window.editMode.selectedFaces.clear();
    window.editMode.selectedFaces.add(topFaceIdx);
    window.editMode.inset(0.25);
    window.editMode.extrude(0.65);
  }
  window.editMode.exit();
  mesh.userData.editedInEditMode = true;
}

studio.addSphere({
  name: "Qua_Cau_PBR_Chrome",
  x: 1.8, y: 1.1, z: 0,
  radius: 1.05,
  color: 0x00d2d3,
  metalness: 0.88,
  roughness: 0.15
});

studio.addLight({
  type: 'point',
  x: 3.5, y: 4.8, z: 3.5,
  color: 0xfff3d1,
  intensity: 2.4
});

print("✓ Đã dựng khối bằng Inset + Extrude trong Edit Mode và phủ vật liệu PBR Kim loại!");
`,
    steps: [
      {
        title: 'Bước 1: Chuyển sang Edit Mode (Phím Tab)',
        targetSelector: '#viewport-mode',
        panel: null,
        voiceText: 'Để nhào nặn một khối hộp đơn giản thành bất kỳ hình thù nào như ngôi nhà, chiếc cốc hay phi thuyền, bạn hãy chọn khối 3D rồi bấm vào ô chế độ ở góc trên bên trái để chuyển từ Object Mode sang Edit Mode, hoặc nhấn phím Tab.',
        actionHint: 'Chuyển ô chế độ (#viewport-mode) sang "Edit Mode" (phím tắt Tab).',
        expectedAction: 'enter_edit_mode'
      },
      {
        title: 'Bước 2: Chọn Mặt (Phím 3) -> Inset (I) & Extrude (E)',
        targetSelector: '#btn-edit-extrude',
        panel: null,
        voiceText: 'Trong Edit Mode, bạn bấm biểu tượng chọn Mặt phím số 3, nhấp chuột vào một mặt của khối hộp, rồi bấm nút Inset phím I để thu nhỏ viền mặt và bấm nút Extrude phím E để đùn khối vươn cao lên!',
        actionHint: 'Chọn một mặt trên khối rồi bấm "Inset (I)", "Extrude (E)" hoặc "Bevel".',
        expectedAction: 'edit_topology'
      },
      {
        title: 'Bước 3: Phủ Vật liệu PBR Kim loại & Thêm Đèn',
        targetSelector: '.dock-tab[data-pane="dock-materials"]',
        panel: 'materials',
        voiceText: 'Sau khi dựng xong hình khối đa giác, bạn mở kệ PBR Materials bên dưới để gán chất liệu kim loại bóng có metalness từ 0.6 trở lên, và thêm 1 đèn từ menu Add để thấy ánh sáng phản chiếu lên các cạnh vừa vát!',
        actionHint: 'Gán vật liệu PBR kim loại và thêm ít nhất 1 nguồn sáng (Point/Sun Light).',
        expectedAction: ['assign_material', 'add_light']
      }
    ],
    rubric: [
      {
        id: 'has-custom-color',
        label: 'Mô hình đã được biến đổi đa giác (Extrude/Inset/Bevel) hoặc phối màu vật liệu riêng',
        points: 25,
        hint: 'Dùng Extrude (E) / Inset (I) trong Edit Mode hoặc đổi màu vật liệu khác màu xám mặc định.',
        check: ({ meshes }) => {
          const coloredOrEdited = meshes.some(m => {
            const hex = getMeshColorHex(m);
            const topo = getMeshTopologyStats(m);
            const hasColor = hex && hex !== '#ffffff' && hex !== '#cccccc' && hex !== '#d2d5da';
            return hasColor || topo.isExtrudedOrEdited;
          });
          return {
            passed: coloredOrEdited,
            feedback: coloredOrEdited
              ? 'Mô hình đã được tạo hình đa giác và phối màu vật liệu.'
              : 'Khối 3D vẫn ở trạng thái nguyên bản. Hãy dùng Extrude/Inset hoặc gán màu vật liệu!'
          };
        }
      },
      {
        id: 'pbr-metallic-glossy',
        label: 'Đạt chuẩn Vật liệu PBR Kim loại (metalness >= 0.6, roughness <= 0.4) hoặc Lưới Edit Mode (> 24 đỉnh)',
        points: 40,
        hint: 'Chọn vật liệu Kim loại trên kệ PBR Materials (metalness >= 0.6, roughness <= 0.4) hoặc dùng Extrude/Inset trong Edit Mode.',
        check: ({ meshes }) => {
          const ok = meshes.some(m => {
            const p = getMeshMaterialProps(m);
            const topo = getMeshTopologyStats(m);
            const pbrPass = (p.metalness ?? 0) >= 0.6 && (p.roughness ?? 1) <= 0.4;
            const editPass = topo.isExtrudedOrEdited && topo.vertexCount > 24;
            return pbrPass || editPass;
          });
          return {
            passed: ok,
            feedback: ok
              ? 'Đạt yêu cầu kỹ thuật Box Modeling / Vật liệu PBR Kim loại bóng.'
              : 'Hãy gán vật liệu PBR kim loại (metalness >= 0.6, roughness <= 0.4) hoặc đùn khối Extrude (E) trong Edit Mode!'
          };
        }
      },
      {
        id: 'has-scene-light',
        label: 'Trang bị nguồn sáng Studio (Add -> Light hoặc studio.addLight)',
        points: 35,
        hint: 'Vào menu Add -> Point Light (hoặc gọi studio.addLight) để chiếu sáng mô hình.',
        check: ({ lights }) => {
          const ok = lights.length >= 1;
          return {
            passed: ok,
            feedback: ok
              ? 'Cảnh 3D đã có ánh sáng và chi tiết khối rõ nét.'
              : 'Hãy thêm ít nhất 1 nguồn sáng từ menu Add -> Point Light (hoặc chạy studio.addLight)!'
          };
        }
      }
    ]
  },

  {
    id: 'lesson-03-loops-architecture',
    number: 3,
    title: 'Bài 3: Modifiers Không Phá Hủy (Array / Mirror / Subdivide), Boolean CSG & Kiến trúc',
    level: 'Trung cấp · Modifiers & CSG',
    durationMinutes: 15,
    xp: 150,
    summary: 'Sử dụng bộ công cụ Modifiers chuẩn Blender (Mirror đối xứng, Array nhân bản hàng loạt, Subdivision làm mịn, Bevel), phép cắt khối Boolean CSG hoặc vòng lặp For để dựng công trình kiến trúc và chi tiết cơ khí phức tạp.',
    objectives: [
      'Áp dụng Modifier (Array / Mirror / Subdivision / Bevel) trong bảng Properties HOẶC dùng vòng lặp for',
      'Tạo cấu trúc có độ chi tiết cao (>= 5 khối 3D hoặc lưới sau Modifier đạt >= 64 đỉnh)',
      'Độ trải rộng của công trình trên mặt bằng đạt >= 4.0m (hoặc >= 6.0m cho đại lộ hàng cột)'
    ],
    starterCode: `// BÀI 3: MODIFIERS (ARRAY / MIRROR / SUBDIVISION) & KIẾN TRÚC HÀNG CỘT 3D
// Cách 1 (Dùng UI Modifiers): Chọn 1 khối -> Mở tab "Modifiers" (biểu tượng cờ-lê bên phải) -> Thêm Mirror / Array / Subdivision!
// Cách 2 (Dùng vòng lặp For kết hợp Modifier):
studio.clearScene();

studio.addPlane({ name: "San_Quang_Truong", x: 0, y: 0, z: 0, width: 24, height: 12, color: 0x2c3e50 });

// TODO: Dùng vòng lặp for (let i = -2; i <= 2; i++) (hoặc Array Modifier) để dựng hàng >= 5 cột trải dài >= 6m!
`,
    solutionCode: `// MẪU THỰC HÀNH BÀI 3: KẾT HỢP MODIFIER & ĐẠI LỘ KIẾN TRÚC 3D
studio.clearScene();

studio.addPlane({
  name: "Dai_Lo_Trung_Tam",
  x: 0, y: 0, z: 0,
  width: 28, height: 16,
  color: 0x1e272e,
  roughness: 0.85
});

// Dựng cổng vòm trung tâm và gắn Bevel / Subdivision Modifier
const arch = studio.addCube({
  name: "Cong_Vom_Modifier",
  x: 0, y: 2.2, z: 0,
  width: 3.2, height: 4.2, depth: 1.2,
  color: 0xfeca57,
  metalness: 0.6,
  roughness: 0.25
});
if (window.modifiers && typeof window.modifiers.applyModifier === 'function') {
  window.modifiers.applyModifier(arch, 'bevel', { width: 0.12 });
}

for (let i = -2; i <= 2; i++) {
  const posX = i * 4.2;
  studio.createBuilding({
    name: \`Thap_Kien_Truc_\${i + 3}\`,
    x: posX,
    y: 0,
    z: -2.8,
    floors: 4 + Math.abs(i),
    width: 2.4,
    depth: 2.4,
    floorHeight: 1.0,
    color: 0x2980b9,
    windowColor: 0x48dbfb
  });

  studio.addCylinder({
    name: \`Cot_Den_\${i + 3}\`,
    x: posX,
    y: 1.2,
    z: 2.2,
    radiusTop: 0.18,
    radiusBottom: 0.25,
    height: 2.4,
    color: 0x38ada9
  });
}

print("✓ Đã dựng công trình kiến trúc kết hợp Modifier và vòng lặp!");
`,
    steps: [
      {
        title: 'Bước 1: Mở Thẻ Modifiers (Biểu tượng Cờ-lê)',
        targetSelector: '.prop-tab-btn[data-tab="modifier"]',
        panel: 'inspector',
        voiceText: 'Trong dựng hình 3D chuyên nghiệp, thay vì làm thủ công từng chi tiết đối xứng hay lặp lại, bạn hãy chọn một khối Mesh rồi bấm vào tab Modifiers hình chiếc cờ-lê ở bảng Properties bên phải.',
        actionHint: 'Bấm vào tab Modifiers (biểu tượng cờ-lê) trên bảng Properties bên phải.',
        expectedAction: 'open_modifiers'
      },
      {
        title: 'Bước 2: Áp dụng Array / Mirror / Subdivision hoặc Vòng lặp For',
        targetSelector: '#inspector-panel',
        panel: 'scripting',
        voiceText: 'Tại đây bạn có thể gắn Mirror để tạo đối xứng gương, Array để nhân bản dãy khối, Subdivision để làm mịn bề mặt, hoặc chạy vòng lặp for trong Scripting Console để dựng hàng cột kiến trúc.',
        actionHint: 'Gắn Modifier lên khối 3D hoặc chạy vòng lặp for tạo >= 5 đối tượng.',
        expectedAction: 'modifier_applied'
      },
      {
        title: 'Bước 3: Kiểm tra Số Đỉnh / Số Đối tượng trên Header',
        targetSelector: '#stat-verts',
        panel: null,
        voiceText: 'Hãy nhìn lên thanh thông số góc phải trên cùng: chỉ số Objects và Verts sẽ cho biết độ chi tiết của mô hình. Khi đã hoàn thiện cấu trúc, bạn bấm Chấm điểm nhé!',
        actionHint: 'Bấm nút "Chấm điểm" để kiểm tra Modifier và cấu trúc kiến trúc.'
      }
    ],
    rubric: [
      {
        id: 'uses-for-loop',
        label: 'Sử dụng Modifier (Array/Mirror/Subdivide/Bevel), Boolean CSG hoặc vòng lặp (for)',
        points: 35,
        hint: 'Gắn Modifier trong tab Modifiers (hình cờ-lê) hoặc sử dụng vòng lặp for trong script.',
        check: ({ code, meshes }) => {
          const hasLoop = /\b(for|while)\s*\(|\.\s*forEach\s*\(|repeatGrid|repeatRadial/i.test(code);
          const hasModifierOrBoolean = meshes.some(m => {
            const topo = getMeshTopologyStats(m);
            return topo.modifierCount > 0 || !!m.userData?.booleanOp;
          });
          const ok = hasLoop || hasModifierOrBoolean;
          return {
            passed: ok,
            feedback: ok
              ? 'Đã áp dụng kỹ thuật Modifier / Boolean hoặc vòng lặp cấu trúc chuẩn xác.'
              : 'Hãy gắn ít nhất 1 Modifier (tab cờ-lê bên phải) hoặc dùng vòng lặp for để nhân bản cấu trúc!'
          };
        }
      },
      {
        id: 'min-five-objects',
        label: 'Đạt độ chi tiết công trình (>= 5 đối tượng 3D hoặc lưới Modifier >= 64 đỉnh)',
        points: 35,
        hint: 'Tạo từ 5 đối tượng 3D trở lên hoặc áp dụng Array / Subdivision / Mirror Modifier.',
        check: ({ objects, meshes }) => {
          const count = Math.max(objects.length, meshes.length);
          const totalVerts = meshes.reduce((acc, m) => acc + getMeshTopologyStats(m).vertexCount, 0);
          const hasMod = meshes.some(m => getMeshTopologyStats(m).modifierCount > 0);
          const ok = count >= 5 || (hasMod && totalVerts >= 48) || totalVerts >= 120;
          return {
            passed: ok,
            feedback: ok
              ? `Độ chi tiết mô hình đạt chuẩn (${count} đối tượng · ${totalVerts} đỉnh).`
              : `Hiện mới có ${count} đối tượng (${totalVerts} đỉnh). Hãy tăng số lượng khối (>= 5) hoặc gắn Modifier Array/Subdivision!`
          };
        }
      },
      {
        id: 'spread-along-axis',
        label: 'Cấu trúc có độ trải rộng không gian hợp lý (>= 6.0m hoặc đã gắn Modifier)',
        points: 30,
        hint: 'Trải đều các cột/khối theo trục X hoặc Z (ví dụ x: i * 3.0) hoặc dùng Array Modifier.',
        check: ({ objects, meshes }) => {
          const list = objects.length >= 5 ? objects : meshes;
          const hasMod = meshes.some(m => getMeshTopologyStats(m).modifierCount > 0);
          if (hasMod && list.length >= 1) {
            return { passed: true, feedback: 'Mô hình sử dụng Modifier không phá hủy đạt chuẩn kỹ thuật.' };
          }
          if (list.length < 3) return { passed: false, feedback: 'Cần thêm các khối hoặc gắn Modifier để hoàn thiện không gian.' };
          const xs = list.map(o => o.position?.x || 0);
          const zs = list.map(o => o.position?.z || 0);
          const spanX = Math.max(...xs) - Math.min(...xs);
          const spanZ = Math.max(...zs) - Math.min(...zs);
          const maxSpan = Math.max(spanX, spanZ);
          const ok = maxSpan >= 6.0;
          return {
            passed: ok,
            feedback: ok
              ? `Công trình trải rộng ${maxSpan.toFixed(1)}m cân đối trên mặt bằng.`
              : `Độ trải rộng hiện đạt ${maxSpan.toFixed(1)}m (cần >= 6.0m). Hãy dàn đều các khối xa nhau hơn!`
          };
        }
      }
    ]
  },

  {
    id: 'lesson-04-prefab-stage',
    number: 4,
    title: 'Bài 4: Điêu khắc 3D (Sculpt Mode), Sân khấu Triển lãm & Ánh sáng 3 Điểm',
    level: 'Trung cấp · Sculpt & LookDev',
    durationMinutes: 15,
    xp: 160,
    summary: 'Khám phá Sculpt Mode với các đầu cọ điêu khắc hữu cơ (Draw, Grab, Smooth, X-Symmetry) và dựng Sân khấu Triển lãm Sản phẩm với hệ thống chiếu sáng Studio đa điểm (Key + Fill + Rim Light).',
    objectives: [
      'Dựng bục sân khấu và mẫu vật trung tâm (có thể dùng Sculpt Mode nặn tượng hoặc lắp ghép khối)',
      'Thiết lập hệ thống chiếu sáng từ 2 nguồn sáng trở lên (Key Light & Fill Light)',
      'Kết hợp chất liệu PBR phản xạ ánh sáng trên sân khấu'
    ],
    starterCode: `// BÀI 4: ĐIÊU KHẮC SCULPT MODE & SÂN KHẤU TRIỂN LÃM ÁNH SÁNG ĐA ĐIỂM
// Mẹo thực hành Sculpt Mode:
//   - Chọn tượng/khối cầu ở giữa sân khấu -> Chuyển "Object Mode" sang "Sculpt Mode".
//   - Dùng cọ Draw / Grab / Smooth với X-Symmetry (ON) để vuốt nặn bề mặt!
studio.clearScene();

// 1. Bục sân khấu tròn khởi điểm
studio.addCylinder({
  name: "Buc_San_Khau",
  x: 0, y: 0.25, z: 0,
  radiusTop: 4.5, radiusBottom: 5.0, height: 0.5,
  color: 0x222f3e, roughness: 0.4, metalness: 0.5
});

// TODO: Đặt thêm tượng/tác phẩm trung tâm trên bục (>= 1.2m) và thêm >= 2 nguồn sáng Key Light + Fill Light!
`,
    solutionCode: `// MẪU THỰC HÀNH BÀI 4: SÂN KHẤU TRIỂN LÃM 3D & ÁNH SÁNG ĐA ĐIỂM
studio.clearScene();

studio.addCylinder({
  name: "Buc_San_Khau_Chinh",
  x: 0, y: 0.25, z: 0,
  radiusTop: 4.8, radiusBottom: 5.2, height: 0.5,
  color: 0x1e272e, roughness: 0.35, metalness: 0.6
});

studio.addTorus({
  name: "Vieng_Den_San_Khau",
  x: 0, y: 0.52, z: 0,
  radius: 4.5, tube: 0.08,
  color: 0x00d2d3, emissive: 0x00d2d3, emissiveIntensity: 1.5
});

studio.addCone({
  name: "Bieu_Tuong_Trung_Tam",
  x: 0, y: 1.9, z: 0,
  radius: 1.1, height: 2.8,
  color: 0xfeca57, metalness: 0.85, roughness: 0.18
});

studio.addLight({ type: 'point', x: 4.5, y: 5.5, z: 4.0, color: 0xfff5e6, intensity: 2.4 });
studio.addLight({ type: 'point', x: -4.5, y: 4.0, z: 3.0, color: 0x48dbfb, intensity: 1.6 });

print("✓ Hoàn tất Sân khấu Triển lãm 3D với hệ thống đèn đa điểm!");
`,
    steps: [
      {
        title: 'Bước 1: Trải nghiệm Điêu khắc 3D (Sculpt Mode)',
        targetSelector: '#viewport-mode',
        panel: null,
        voiceText: 'Đối với các mô hình hữu cơ như khuôn mặt, nhân vật hay tượng nghệ thuật, bạn hãy chọn khối cầu trung tâm rồi chuyển chế độ ở góc trên bên trái sang Sculpt Mode để dùng các đầu cọ Draw, Grab và Smooth nặn trực tiếp trên bề mặt với đối xứng X-Symmetry!',
        actionHint: 'Thử chuyển sang "Sculpt Mode" để nặn khối hoặc dựng bục sân khấu + mẫu vật trung tâm.',
        expectedAction: 'sculpt_active'
      },
      {
        title: 'Bước 2: Thiết lập Ánh sáng Studio & Cyclorama',
        targetSelector: '#btn-shading-popover',
        panel: null,
        voiceText: 'Để trưng bày mô hình đẹp như chụp ảnh thương mại, bạn cần ít nhất 2 nguồn sáng chiếu từ hai góc đối diện (Key Light và Fill Light), đồng thời có thể bật phông nền uốn cong Studio Cyclorama trong bảng Shading Popover.',
        actionHint: 'Đảm bảo cảnh có bục trưng bày, vật thể trung tâm và >= 2 nguồn sáng.',
        expectedAction: 'add_light'
      },
      {
        title: 'Bước 3: Canh khung hình Camera (Focus - Phím F)',
        targetSelector: '#btn-focus-object',
        panel: null,
        voiceText: 'Cuối cùng, bấm nút Focus hoặc nhấn Numpad chấm để camera căn chỉnh khung hình hoàn hảo trước khi bấm Chấm điểm!',
        actionHint: 'Bấm Focus để canh khung, rồi "Chấm điểm" kiểm tra bố cục sân khấu và hệ thống đèn.',
        expectedAction: 'focus_view'
      }
    ],
    rubric: [
      {
        id: 'stage-structure',
        label: 'Có bục sân khấu và mô hình trưng bày / điêu khắc (>= 2 Mesh)',
        points: 40,
        hint: 'Tạo ít nhất 1 bục sân khấu và 1 mô hình trưng bày ở trung tâm.',
        check: ({ meshes }) => {
          const hasSculptMesh = meshes.some(m => m.userData?.sculpted || getMeshTopologyStats(m).vertexCount >= 120);
          const ok = meshes.length >= 2 || (meshes.length >= 1 && hasSculptMesh);
          return {
            passed: ok,
            feedback: ok
              ? `Sân khấu đã có ${meshes.length} thành phần hình học hoàn chỉnh.`
              : 'Cần có ít nhất bục sân khấu và mô hình trưng bày ở trung tâm (>= 2 Mesh).'
          };
        }
      },
      {
        id: 'multi-point-lighting',
        label: 'Trang bị hệ thống chiếu sáng đa điểm (>= 2 đèn Studio)',
        points: 60,
        hint: 'Thêm ít nhất 2 đèn từ menu Add -> Light hoặc gọi studio.addLight(...) 2 lần.',
        check: ({ lights, code }) => {
          const codeLightMatches = (code.match(/addLight\s*\(/g) || []).length;
          const count = Math.max(lights.length, codeLightMatches);
          const ok = count >= 2;
          return {
            passed: ok,
            feedback: ok
              ? `Đã thiết lập ${count} nguồn sáng chiếu sân khấu chuẩn Studio.`
              : `Hiện mới có ${count} nguồn sáng (cần ít nhất 2 đèn: Key Light và Fill Light).`
          };
        }
      }
    ]
  },

  {
    id: 'lesson-05-animation',
    number: 5,
    title: 'Bài 5: Khung Xương Nhân vật (Rigging / Pose), AI Mocap & Hoạt cảnh Timeline',
    level: 'Nâng cao · Rig & Animation',
    durationMinutes: 15,
    xp: 200,
    summary: 'Đưa sự sống vào mô hình 3D: Thêm nhân vật có khung xương (Humanoid / Michelle / Soldier), tạo dáng trong Pose & Rigging, trích xuất chuyển động từ Video AI Mocap hoặc lập trình hoạt cảnh thời gian thực 60 FPS.',
    objectives: [
      'Đưa mô hình 3D hoặc nhân vật khung xương vào cảnh',
      'Tạo chuyển động bằng Timeline Keyframe, Pose & Rigging, Video Mocap HOẶC hàm studio.animate()',
      'Kiểm tra hoạt cảnh phát mượt mà trên Viewport'
    ],
    starterCode: `// BÀI 5: KHUNG XƯƠNG NHÂN VẬT, TIMELINE KEYFRAME & HOẠT CẢNH 60 FPS
// Cách 1 (Trực quan): Mở tab "Pose & Rigging" / "Timeline" / "Video Mocap (AI)" ở thanh Dock dưới để tạo dáng & gắn chuyển động!
// Cách 2 (Lập trình Hoạt cảnh Thời gian thực):
studio.clearScene();

const crystal = studio.addCone({
  name: "Tinh_The_Nang_Luong",
  x: 0, y: 1.8, z: 0,
  radius: 0.9, height: 2.2,
  color: 0x00d2d3,
  metalness: 0.8,
  roughness: 0.15
});

// TODO: Đăng ký hàm diễn hoạt thời gian thực bằng studio.animate((time, delta) => { ... })
// hoặc đặt Keyframe trên Timeline / thêm nhân vật Rig để tạo chuyển động!
`,
    solutionCode: `// MẪU THỰC HÀNH BÀI 5: HOẠT CẢNH VỆ TINH & TINH THỂ NĂNG LƯỢNG 60 FPS
studio.clearScene();

const core = studio.addCone({
  name: "Tinh_The_Trung_Tam",
  x: 0, y: 1.8, z: 0,
  radius: 0.9, height: 2.2,
  color: 0x00d2d3,
  metalness: 0.85,
  roughness: 0.15
});

const ring = studio.addTorus({
  name: "Vong_Quy_Dao",
  x: 0, y: 1.8, z: 0,
  radius: 1.8, tube: 0.08,
  color: 0xff9f43,
  metalness: 0.7,
  roughness: 0.2
});

studio.animate((time, delta) => {
  const t = Number.isFinite(time) ? time : Date.now() * 0.002;
  const dt = Number.isFinite(delta) ? delta : 0.016;
  core.rotation.y += dt * 2.4;
  core.position.y = 1.8 + Math.sin(t * 2.5) * 0.35;
  ring.rotation.x = t * 1.2;
  ring.rotation.z = t * 0.8;
});

print("✓ Đã kích hoạt hoạt cảnh thời gian thực 60 FPS!");
`,
    steps: [
      {
        title: 'Bước 1: Khung Xương Nhân vật (Pose & Rigging) hoặc Mô hình Diễn hoạt',
        targetSelector: '.dock-tab[data-pane="dock-pose"]',
        panel: 'pose',
        voiceText: 'Trong bài học này, bạn sẽ làm cho mô hình 3D sống dậy! Bạn có thể mở tab Pose and Rigging ở thanh dưới để thêm khung xương nhân vật và xoay các khớp xương, hoặc dùng hàm studio chấm animate.',
        actionHint: 'Xem tab Pose & Rigging hoặc mở Scripting Console để chạy mẫu hoạt cảnh.'
      },
      {
        title: 'Bước 2: Thanh Thời gian Timeline & Video AI Mocap',
        targetSelector: '#timeline-controls-bar',
        panel: 'timeline',
        voiceText: 'Tại thanh điều khiển Timeline, bạn có thể đặt Keyframe vị trí, góc xoay theo từng khung hình, hoặc mở tab Video Mocap AI để trích xuất chuyển động từ video người thật áp thẳng vào nhân vật 3D!',
        actionHint: 'Đặt Keyframe trên Timeline hoặc bấm Chạy đoạn mã studio.animate(...).',
        expectedAction: 'animate_started'
      },
      {
        title: 'Bước 3: Phát Hoạt cảnh & Chấm điểm',
        targetSelector: '#btn-timeline-play',
        panel: null,
        voiceText: 'Khi mô hình hoặc nhân vật của bạn đã có hoạt cảnh chuyển động, hãy bấm nút Chấm điểm để hoàn thành bài học!',
        actionHint: 'Bấm nút "Chấm điểm" khi hoạt cảnh đã được kích hoạt.'
      }
    ],
    rubric: [
      {
        id: 'has-animated-mesh',
        label: 'Có mô hình 3D hoặc nhân vật khung xương trong cảnh để diễn hoạt',
        points: 30,
        hint: 'Thêm ít nhất 1 khối Mesh hoặc nhân vật (Add -> Michelle / Mannequin / Cube) vào cảnh.',
        check: ({ meshes, objects }) => {
          const count = Math.max(meshes.length, objects.length);
          return {
            passed: count >= 1,
            feedback: count >= 1
              ? `Đã có ${count} đối tượng 3D tham gia hoạt cảnh.`
              : 'Chưa có mô hình 3D nào trong cảnh.'
          };
        }
      },
      {
        id: 'uses-animation-driver',
        label: 'Kích hoạt chuyển động bằng Timeline Keyframe, Pose Rig, Mocap Clip hoặc studio.animate()',
        points: 70,
        hint: 'Đặt keyframe trên Timeline, xoay xương trong Pose & Rigging, hoặc gọi studio.animate(...) trong script.',
        check: ({ code, studioInstance, timelineEngine }) => {
          const codeHasAnimate = /studio\s*\.\s*animate\s*\(/i.test(code) && /(rotation|position|scale)/i.test(code);
          const activeCallbacks =
            (Array.isArray(studioInstance?._animCallbacks) && studioInstance._animCallbacks.length > 0) ||
            (Array.isArray(studioInstance?._animationCallbacks) && studioInstance._animationCallbacks.length > 0);
          const hasTimelineKeys = timelineEngine && (
            (timelineEngine.tracks instanceof Map && timelineEngine.tracks.size > 0) ||
            (timelineEngine.clips instanceof Map && timelineEngine.clips.size > 0) ||
            (timelineEngine.keyframes instanceof Map && timelineEngine.keyframes.size > 0) ||
            (timelineEngine._clips instanceof Map && timelineEngine._clips.size > 0)
          );
          const ok = codeHasAnimate || activeCallbacks || !!hasTimelineKeys;
          return {
            passed: ok,
            feedback: ok
              ? 'Hoạt cảnh chuyển động 3D / Khung xương đã được kích hoạt thành công.'
              : 'Chưa phát hiện hoạt cảnh. Hãy gọi studio.animate(...), đặt Keyframe trên Timeline, hoặc thêm nhân vật Rig!'
          };
        }
      }
    ]
  },

  {
    id: 'lesson-06-physics',
    number: 6,
    title: 'Bài 6: Phối hợp AI Copilot, Vật lý Va chạm (Rapier 3D) & Xuất bản GLB',
    level: 'Nâng cao · Physics & Export',
    durationMinutes: 15,
    xp: 220,
    summary: 'Hoàn thiện quy trình sản xuất 3D: Dùng AI Copilot hỗ trợ dựng cảnh, gắn vật lý cứng (Rigid Body Dynamic & Fixed) bằng engine Rapier WASM, nướng chuyển động (Bake to Timeline) và sẵn sàng xuất file .glb cho Unity / Godot / Web.',
    objectives: [
      'Đặt ít nhất 1 vật thể ở độ cao Y >= 2.5m để mô phỏng rơi tự do và va chạm',
      'Bật thuộc tính Rigid Body Dynamic (trong tab Physics hoặc userData.physics)',
      'Nắm vững quy trình Bake vật lý ra Timeline và xuất file chuẩn glTF 2.0 (.glb)'
    ],
    starterCode: `// BÀI 6: MÔ PHỎNG VẬT LÝ VA CHẠM RAPIER 3D & XUẤT BẢN MÔ HÌNH (.GLB)
// Cách 1 (Trực quan): Chọn khối -> Nâng lên Y >= 2.5m -> Mở tab "Physics" -> Bật Dynamic -> bấm #phys-play!
// Cách 2 (Chạy script): Đặt vật ở Y >= 2.5m rồi gọi simulationManager.setConfig(obj, { body: 'dynamic' }).
studio.clearScene();

const block = studio.addCube({
  name: "Khoi_Chua_Gan_Vat_Ly",
  x: 0, y: 0.6, z: 0,
  width: 1.2, height: 1.2, depth: 1.2,
  color: 0x95a5a6
});

// TODO: Đặt tọa độ y >= 2.5m và gắn Rigid Body Dynamic (userData.physics / simulationManager.setConfig)!
`,
    solutionCode: `// MẪU THỰC HÀNH BÀI 6: MÔ PHỎNG VẬT LÝ RAPIER 3D & SẴN SÀNG XUẤT GLB
studio.clearScene();

const ball = studio.addSphere({
  name: "Bong_Nay_Vat_Ly",
  x: 0, y: 4.5, z: 0,
  radius: 0.8,
  color: 0xff6b6b,
  roughness: 0.3
});

const box = studio.addCube({
  name: "Thung_Vat_Ly",
  x: 0.35, y: 7.2, z: 0,
  width: 1.3, height: 1.3, depth: 1.3,
  color: 0xfeca57,
  roughness: 0.5
});

if (window.simulationManager) {
  await window.simulationManager.ensureInit?.();
  window.simulationManager.setConfig(ball, { body: 'dynamic', collider: 'sphere', mass: 1.5, restitution: 0.8, friction: 0.4 });
  window.simulationManager.setConfig(box, { body: 'dynamic', collider: 'box', mass: 2.0, restitution: 0.45, friction: 0.6 });
} else {
  ball.userData.physics = { body: 'dynamic', collider: 'sphere', mass: 1.5, restitution: 0.8, friction: 0.4 };
  box.userData.physics = { body: 'dynamic', collider: 'box', mass: 2.0, restitution: 0.45, friction: 0.6 };
}
print("✓ Đã thiết lập 2 vật thể Dynamic sẵn sàng mô phỏng trọng lực 9.81 m/s² và xuất .glb!");
`,
    steps: [
      {
        title: 'Bước 1: Mở Bảng Điều khiển Vật lý (Physics Dock) & Phát thử (#phys-play)',
        targetSelector: '#phys-play',
        panel: 'physics',
        voiceText: 'Ở bài cuối cùng này, bạn hãy mở tab Physics ở thanh dưới cùng. Khi chọn một vật thể 3D đặt ở trên cao và bật Rigid Body kiểu Dynamic bằng simulationManager.setConfig({ body: "dynamic" }), bấm Play mô phỏng vật lý để Rapier tính toán trọng lực 9.81 mét trên giây bình phương!',
        actionHint: 'Mở tab Physics, bật Rigid Body Dynamic và bấm #phys-play (hoặc Chạy mẫu).',
        expectedAction: 'physics_enabled'
      },
      {
        title: 'Bước 2: Kết hợp Trợ lý AI Copilot 3D',
        targetSelector: '#tool-ai-fab',
        panel: null,
        voiceText: 'Bạn cũng có thể bấm nút AI Copilot ở góc dưới thanh công cụ bên trái (hoặc dùng ô Hỏi Giáo viên AI ngay trên thanh hướng dẫn này) để nhờ mô hình AI của bạn dựng thêm đạo cụ hoặc chỉ dẫn từng thao tác trên giao diện.',
        actionHint: 'Khám phá nút AI Copilot (#tool-ai-fab) hoặc ô Hỏi Giáo viên AI.'
      },
      {
        title: 'Bước 3: Xuất bản Mô hình ra File .GLB (File -> Export)',
        targetSelector: '#menu-file',
        panel: null,
        voiceText: 'Sau khi hoàn thiện mô hình và hoạt cảnh, bạn vào menu File, chọn Export glTF 2.0 Binary chấm glb hoặc Share Embed 3D để mang sản phẩm sang Unity, Godot, Roblox hay nhúng lên website. Giờ hãy bấm Chấm điểm để tốt nghiệp khóa học nhé!',
        actionHint: 'Bấm "Chấm điểm" để hoàn tất khóa học Dựng hình 3D!'
      }
    ],
    rubric: [
      {
        id: 'elevated-object',
        label: 'Có vật thể đặt ở độ cao rơi tự do (Y >= 2.5m) hoặc đã gắn cấu hình vật lý',
        points: 40,
        hint: 'Đặt tọa độ y >= 2.5 cho khối cầu hoặc khối hộp để vật có quãng đường rơi.',
        check: ({ meshes }) => {
          const ok = meshes.some(m => (m.position?.y ?? 0) >= 2.5 || m.userData?.physics?.enabled);
          return {
            passed: ok,
            feedback: ok
              ? 'Vật thể đã được đặt ở độ cao hợp lý để mô phỏng trọng lực.'
              : 'Hãy đặt ít nhất 1 vật thể ở độ cao y >= 2.5m.'
          };
        }
      },
      {
        id: 'dynamic-physics-config',
        label: 'Thiết lập thuộc tính vật lý Dynamic (userData.physics.body = "dynamic")',
        points: 60,
        hint: 'Bật Rigid Body Dynamic trong tab Physics hoặc dùng simulationManager.setConfig(obj, { body: "dynamic" }).',
        check: ({ meshes, code, simulationManager }) => {
          const meshHasDynamic = meshes.some(m => m.userData?.physics && (m.userData.physics.body === 'dynamic' || m.userData.physics.type === 'dynamic' || m.userData.physics.enabled));
          const simHasDynamic = simulationManager?.bodies instanceof Map && [...simulationManager.bodies.values()].some(b => (b?.config?.body || b?.config?.type) === 'dynamic');
          const codeHasDynamic = /physics\s*[:=]\s*\{[\s\S]*dynamic|setConfig\([\s\S]*dynamic/i.test(code);
          const ok = meshHasDynamic || simHasDynamic || (meshes.length >= 1 && codeHasDynamic);
          return {
            passed: ok,
            feedback: ok
              ? 'Đã cấu hình Rigid Body Dynamic thành công.'
              : 'Chưa có vật thể nào được bật userData.physics với type: "dynamic".'
          };
        }
      }
    ]
  }
];

/**
 * Tìm bài học theo id hoặc số thứ tự.
 */
export function getStemLesson(idOrNumber) {
  if (typeof idOrNumber === 'number') {
    return STEM_LESSONS.find(l => l.number === idOrNumber) || null;
  }
  const key = String(idOrNumber || '').trim();
  return STEM_LESSONS.find(l => l.id === key || String(l.number) === key) || null;
}

/**
 * Chấm điểm tự động một bài học dựa trên hình học 3D thực tế (Topology, BoundingBox, Modifiers, PBR, Animation, Physics).
 * Chạy được trong cả Node.js (unit test) lẫn trình duyệt.
 */
export function gradeStemLesson(lessonId, context = {}) {
  const lesson = getStemLesson(lessonId);
  if (!lesson) {
    throw new Error(`Không tìm thấy bài học STEM '${lessonId}'.`);
  }

  const rawObjects = context.objects || collectUserSceneObjects(context.sceneManager);
  const meshes = context.meshes || rawObjects.filter(o => o && (o.isMesh || o.type === 'Mesh' || o.geometry));
  const lights = context.lights || rawObjects.filter(o => o && (o.isLight || /Light$/i.test(o.type || '') || o.userData?.isStudioLight));
  const code = typeof context.code === 'string' ? context.code : '';

  const evalCtx = {
    objects: rawObjects,
    meshes,
    lights,
    code,
    sceneManager: context.sceneManager || null,
    studioInstance: context.studio || null,
    timelineEngine: context.timelineEngine || null,
    simulationManager: context.simulationManager || null
  };

  let totalPoints = 0;
  let earnedPoints = 0;
  const criteria = [];

  for (const item of lesson.rubric) {
    totalPoints += item.points;
    let passed = false;
    let feedback = '';
    try {
      const res = item.check(evalCtx);
      passed = !!res?.passed;
      feedback = res?.feedback || (passed ? 'Đạt yêu cầu.' : item.hint);
    } catch (err) {
      passed = false;
      feedback = `Lỗi khi kiểm tra tiêu chí: ${err.message}`;
    }
    const earned = passed ? item.points : 0;
    earnedPoints += earned;
    criteria.push({
      id: item.id,
      label: item.label,
      points: item.points,
      earned,
      passed,
      feedback,
      hint: item.hint
    });
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
  const passed = score >= 70;
  const passedCount = criteria.filter(c => c.passed).length;

  let gradeLetter = 'Cần cố gắng (C)';
  if (score === 100) gradeLetter = 'Xuất sắc (A+)';
  else if (score >= 85) gradeLetter = 'Giỏi (A)';
  else if (score >= 70) gradeLetter = 'Đạt (B)';

  const firstFailed = criteria.find(c => !c.passed);
  const teacherVoiceSummary = score === 100
    ? `Tuyệt vời! Bạn đạt tuyệt đối 100 trên 100 điểm ở ${lesson.title}. Kỹ năng dựng mô hình 3D của bạn rất chuẩn xác!`
    : passed
      ? `Chúc mừng bạn! Bạn đạt ${score} trên 100 điểm (${passedCount}/${criteria.length} tiêu chí) và đã vượt qua bài học. ${firstFailed ? 'Gợi ý thêm: ' + firstFailed.hint : ''}`
      : `Bạn hiện đạt ${score} trên 100 điểm. Để hoàn thành mô hình này, bạn chú ý: ${firstFailed ? firstFailed.hint : 'hãy thực hiện tiếp bước hướng dẫn nhé!'}`;

  return {
    lessonId: lesson.id,
    lessonNumber: lesson.number,
    title: lesson.title,
    score,
    maxScore: 100,
    passed,
    gradeLetter,
    passedCount,
    totalCriteria: criteria.length,
    xpAwarded: passed ? Math.round(lesson.xp * (score / 100)) : 0,
    criteria,
    teacherVoiceSummary,
    gradedAt: new Date().toISOString()
  };
}

// ============================================================================
// TOÁN HỌC ĐỊNH VỊ CON TRỎ GIÁO VIÊN KHÔNG CHẮN GIAO DIỆN (ZERO-OVERLAP MATH)
// ============================================================================

/**
 * Kiểm tra diện tích giao nhau giữa 2 hình chữ nhật.
 */
function rectOverlapArea(a, b) {
  const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return xOverlap * yOverlap;
}

/**
 * Tính toán vị trí đích (x, y) cho Con trỏ Giáo viên AI (nhỏ gọn 44px, không kèm bong bóng thoại to)
 * khi bay tới chỉ vào một phần tử UI có bounding rect `targetRect`.
 *
 * Đảm bảo:
 *  1. Nằm gọn trong màn hình `viewport` (không tràn lề).
 *  2. KHÔNG BAO GIỜ đè lên `targetRect` (diện tích chồng lấp = 0, cách rìa nút >= 14px) để học viên bấm nút dễ dàng.
 *  3. Nếu truyền `cursorPos` (vị trí chuột của người dùng), tự động né sang hướng đối diện để không cản chuột.
 */
export function computeAvatarTargetPosition(
  targetRect,
  viewport = { width: 1280, height: 800 },
  avatarSize = 44,
  cursorPos = null
) {
  const vw = Math.max(320, Number(viewport?.width) || 1280);
  const vh = Math.max(240, Number(viewport?.height) || 800);
  const margin = 12;
  const gap = 14;

  if (!targetRect || !(targetRect.width > 0 || targetRect.height > 0)) {
    const defaultX = clamp(vw - avatarSize - 24, margin, vw - avatarSize - margin);
    const defaultY = clamp(56, margin, vh - avatarSize - margin);
    return {
      x: Math.round(defaultX),
      y: Math.round(defaultY),
      pointerDirection: 'none',
      bubbleSide: 'left',
      targetCenter: null,
      overlapsTarget: false
    };
  }

  const tLeft = Number(targetRect.left) || 0;
  const tTop = Number(targetRect.top) || 0;
  const tWidth = Math.max(1, Number(targetRect.width) || 24);
  const tHeight = Math.max(1, Number(targetRect.height) || 24);
  const tRight = Number(targetRect.right) || (tLeft + tWidth);
  const tBottom = Number(targetRect.bottom) || (tTop + tHeight);

  const cx = tLeft + tWidth / 2;
  const cy = tTop + tHeight / 2;

  // Khởi tạo 4 vị trí ứng viên xung quanh nút mục tiêu (bên dưới, bên phải, bên trái, bên trên)
  const candidates = [
    {
      dir: 'up', // Đặt dưới nút, mũi tên chỉ lên
      x: cx - avatarSize / 2,
      y: tBottom + gap,
      priority: tTop < 100 ? 100 : 50
    },
    {
      dir: 'left', // Đặt bên phải nút, mũi tên chỉ sang trái
      x: tRight + gap,
      y: cy - avatarSize / 2,
      priority: tLeft < 120 ? 95 : 60
    },
    {
      dir: 'right', // Đặt bên trái nút, mũi tên chỉ sang phải
      x: tLeft - avatarSize - gap,
      y: cy - avatarSize / 2,
      priority: cx > vw * 0.6 ? 95 : 55
    },
    {
      dir: 'down', // Đặt phía trên nút, mũi tên chỉ xuống
      x: cx - avatarSize / 2,
      y: tTop - avatarSize - gap,
      priority: tTop > vh * 0.55 ? 95 : 45
    }
  ];

  const expandedTarget = {
    left: tLeft - 4,
    top: tTop - 4,
    right: tRight + 4,
    bottom: tBottom + 4
  };

  let best = null;
  let bestScore = -Infinity;

  for (const cand of candidates) {
    const clampedX = clamp(cand.x, margin, vw - avatarSize - margin);
    const clampedY = clamp(cand.y, margin + 32, vh - avatarSize - margin);
    const avatarBox = {
      left: clampedX,
      top: clampedY,
      right: clampedX + avatarSize,
      bottom: clampedY + avatarSize
    };

    const overlap = rectOverlapArea(avatarBox, expandedTarget);
    const inBoundsPenalty = Math.hypot(clampedX - cand.x, clampedY - cand.y);

    // Nếu người dùng đang để chuột gần ứng viên này, trừ điểm để tự động né chuột
    let cursorPenalty = 0;
    if (cursorPos && Number.isFinite(cursorPos.x) && Number.isFinite(cursorPos.y)) {
      const distToCursor = Math.hypot(
        (clampedX + avatarSize / 2) - cursorPos.x,
        (clampedY + avatarSize / 2) - cursorPos.y
      );
      if (distToCursor < 80) {
        cursorPenalty = (80 - distToCursor) * 5;
      }
    }

    const score = cand.priority - overlap * 10 - inBoundsPenalty * 2 - cursorPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = {
        x: Math.round(clampedX),
        y: Math.round(clampedY),
        pointerDirection: cand.dir,
        overlapsTarget: overlap > 0
      };
    }
  }

  const bubbleSide = best.x > vw - 380 ? 'left' : 'right';
  const angleRad = Math.atan2(cy - (best.y + avatarSize / 2), cx - (best.x + avatarSize / 2));
  const arrowAngleDeg = Math.round((angleRad * 180) / Math.PI);

  return {
    x: best.x,
    y: best.y,
    pointerDirection: best.pointerDirection,
    arrowAngleDeg,
    bubbleSide,
    targetCenter: { x: Math.round(cx), y: Math.round(cy) },
    overlapsTarget: best.overlapsTarget
  };
}

// ============================================================================
// BỘ PHÁT GIỌNG NÓI GIÁO VIÊN KÈM 1-1 TỐC ĐỘ CAO
// (NEURAL TTS STREAM /api/tts + PRE-FETCH CACHE + TỐC ĐỘ 1.2x + FALLBACK MƯỢT)
// ============================================================================

export class TutorVoiceEngine {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.lang = options.lang || 'vi-VN';
    // Mặc định tốc độ 1.2x để giọng giảng bài nhanh nhẹn, tự nhiên, không bị rề rà
    this.rate = clamp(Number(options.rate) || 1.2, 0.5, 2.0);
    this.pitch = clamp(Number(options.pitch) || 1.04, 0.5, 2.0);
    this.volume = clamp(Number(options.volume ?? 1.0), 0, 1);
    this.preferNeuralServer = options.preferNeuralServer !== false;
    this.isSpeaking = false;
    this.lastSpokenText = '';
    this.history = [];
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this._synth = options.speechSynthesis || (typeof window !== 'undefined' ? window.speechSynthesis : null);
    this._utteranceFactory = options.utteranceFactory || ((text) => {
      if (typeof SpeechSynthesisUtterance !== 'undefined') {
        return new SpeechSynthesisUtterance(text);
      }
      return { text, lang: this.lang, rate: this.rate, pitch: this.pitch, volume: this.volume };
    });
    this._audioCache = new Map(); // cleanText -> Promise<string|null> (blobUrl)
    this._activeAudio = null;
    this._speakToken = 0;
    this._fallbackTimer = null;
    this._cachedVoices = [];
    this._voicesChangedHandler = () => {
      try {
        this._cachedVoices = this._synth?.getVoices?.() || [];
      } catch (_) {}
    };
    if (this._synth) {
      this._voicesChangedHandler();
      if (typeof this._synth.addEventListener === 'function') {
        this._synth.addEventListener('voiceschanged', this._voicesChangedHandler);
      } else if ('onvoiceschanged' in this._synth) {
        this._synth.onvoiceschanged = this._voicesChangedHandler;
      }
    }
  }

  /**
   * Làm sạch chuỗi văn bản trước khi đọc để không đọc các ký tự code/markdown thô.
   */
  static normalizeSpeechText(rawText) {
    return String(rawText || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#[a-zA-Z0-9_-]+/g, ' ')
      .replace(/->|→/g, ' vào ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Tìm giọng đọc tiếng Việt (vi-VN) tốt nhất có trên trình duyệt (dùng cho fallback offline).
   */
  pickVoice() {
    if (!this._synth || typeof this._synth.getVoices !== 'function') return null;
    const live = this._synth.getVoices() || [];
    const voices = live.length ? live : (this._cachedVoices || []);
    if (!voices.length) return null;
    return (
      voices.find(v => /^vi(-|_|$)/i.test(v.lang || '') && /natural|neural|google|microsoft|linh|hoai|an|nam/i.test(v.name || '')) ||
      voices.find(v => /^vi(-|_|$)/i.test(v.lang || '')) ||
      voices.find(v => /vietnam/i.test(v.name || '')) ||
      voices[0]
    );
  }

  setRate(rate) {
    this.rate = clamp(Number(rate) || 1.2, 0.75, 2.0);
    if (this._activeAudio) {
      try {
        this._activeAudio.playbackRate = this.rate;
      } catch (_) {}
    }
    return this.rate;
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      this.stop();
    }
    this._emitState();
    return this.enabled;
  }

  /**
   * Tải trước (Pre-fetch) audio neural tiếng Việt từ `/api/tts` vào bộ nhớ đệm Blob URL
   * để khi người dùng chuyển bước học là phát ngay lập tức (< 10ms, không chờ mạng).
   */
  prefetch(text) {
    const cleanText = TutorVoiceEngine.normalizeSpeechText(text);
    if (!cleanText || cleanText.length < 2) return Promise.resolve(null);
    if (this._audioCache.has(cleanText)) {
      return this._audioCache.get(cleanText);
    }
    if (
      !this.preferNeuralServer ||
      typeof window === 'undefined' ||
      typeof window.fetch !== 'function' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return Promise.resolve(null);
    }

    const promise = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 3500) : null;
      try {
        const url = `/api/tts?lang=vi&text=${encodeURIComponent(cleanText.slice(0, 700))}`;
        const resp = await window.fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined
        });
        if (!resp.ok) return null;
        const ctype = (resp.headers.get('content-type') || '').toLowerCase();
        if (!ctype.includes('audio')) return null;
        const blob = await resp.blob();
        if (!blob || blob.size < 128) return null;
        return URL.createObjectURL(blob);
      } catch (_) {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();

    this._audioCache.set(cleanText, promise);
    // Giới hạn cache 40 câu gần nhất & thu hồi Blob URL cũ tránh rò rỉ bộ nhớ
    if (this._audioCache.size > 40) {
      const oldestKey = this._audioCache.keys().next().value;
      const evictedPromise = this._audioCache.get(oldestKey);
      this._audioCache.delete(oldestKey);
      Promise.resolve(evictedPromise).then((url) => {
        if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          try { URL.revokeObjectURL(url); } catch (_) {}
        }
      }).catch(() => {});
    }
    return promise;
  }

  dispose() {
    this.stop();
    if (this._audioCache) {
      for (const promise of this._audioCache.values()) {
        Promise.resolve(promise).then((url) => {
          if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(url); } catch (_) {}
          }
        }).catch(() => {});
      }
      this._audioCache.clear();
    }
    if (this._synth && this._voicesChangedHandler) {
      if (typeof this._synth.removeEventListener === 'function') {
        this._synth.removeEventListener('voiceschanged', this._voicesChangedHandler);
      } else if (this._synth.onvoiceschanged === this._voicesChangedHandler) {
        this._synth.onvoiceschanged = null;
      }
    }
  }

  stop() {
    this._speakToken++;
    const cancelEnd = this._activeCancelEnd;
    this._activeCancelEnd = null;
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
    if (this._activeAudio) {
      try {
        this._activeAudio.pause();
        this._activeAudio.currentTime = 0;
      } catch (_) {}
      this._activeAudio = null;
    }
    try {
      if (this._synth && typeof this._synth.cancel === 'function') {
        this._synth.cancel();
      }
    } catch (_) {}
    if (this.isSpeaking) {
      this.isSpeaking = false;
      this._emitState();
    }
    if (typeof cancelEnd === 'function') {
      try { cancelEnd({ failed: false, cancelled: true }); } catch (_) {}
    }
  }

  /**
   * Phát giọng nói của giáo viên 1-1.
   * Ưu tiên:
   *  1. Neural TTS tiếng Việt tốc độ cao qua `/api/tts` (HTMLAudioElement với playbackRate = 1.2x)
   *     khi chạy trên trình duyệt thật (không dùng custom mock speechSynthesis).
   *  2. Web Speech API (`Linh` / `vi-VN` ở tốc độ 1.2x).
   *  3. WebAudio chime fallback.
   * Trả về đồng bộ `{ spoken, engine, voiceName, lang, text }`.
   */
  speak(text, opts = {}) {
    const cleanText = TutorVoiceEngine.normalizeSpeechText(text);
    if (!cleanText) return { spoken: false, reason: 'empty', text: '' };

    this.stop();
    const token = ++this._speakToken;
    const playRate = clamp(Number(opts.rate ?? this.rate), 0.75, 2.0);

    this.lastSpokenText = cleanText;
    this.history.push({
      text: cleanText,
      ts: Date.now(),
      rate: playRate,
      muted: !this.enabled && !opts.force
    });
    if (this.history.length > 50) this.history.shift();

    if (!this.enabled && !opts.force) {
      return { spoken: false, reason: 'muted', text: cleanText };
    }

    this.isSpeaking = true;
    this._activeCancelEnd = typeof opts.onEnd === 'function' ? opts.onEnd : null;
    this._emitState(cleanText);

    const canUseNeuralAudio =
      this.preferNeuralServer &&
      !opts.forceWebSpeech &&
      typeof window !== 'undefined' &&
      typeof window.Audio === 'function' &&
      typeof window.fetch === 'function' &&
      this._synth === window.speechSynthesis;

    // 1. Nhánh Neural TTS chất lượng cao (/api/tts + Pre-fetch Cache + tốc độ 1.2x)
    if (canUseNeuralAudio) {
      this.prefetch(cleanText).then((blobUrl) => {
        if (token !== this._speakToken) return;
        if (blobUrl) {
          try {
            const audio = new window.Audio(blobUrl);
            audio.volume = clamp(Number(opts.volume ?? this.volume), 0, 1);
            audio.playbackRate = playRate;
            audio.defaultPlaybackRate = playRate;
            this._activeAudio = audio;

            const finishAudio = (status = { failed: false }) => {
              if (token !== this._speakToken) return;
              if (this._activeCancelEnd === opts.onEnd) {
                this._activeCancelEnd = null;
              }
              if (this._fallbackTimer) {
                clearTimeout(this._fallbackTimer);
                this._fallbackTimer = null;
              }
              this._activeAudio = null;
              if (this.isSpeaking) {
                this.isSpeaking = false;
                this._emitState(cleanText);
              }
              opts.onEnd?.(status);
            };

            audio.onended = () => finishAudio({ failed: false });
            audio.onerror = () => {
              this._activeAudio = null;
              this._speakWithWebSpeechOrChime(cleanText, playRate, token, opts);
            };

            const playPromise = audio.play();
            if (playPromise && typeof playPromise.catch === 'function') {
              playPromise.catch(() => {
                this._activeAudio = null;
                this._speakWithWebSpeechOrChime(cleanText, playRate, token, opts);
              });
            }
            const maxMs = clamp(Math.round((cleanText.length * 65) / playRate), 1200, 18000);
            this._fallbackTimer = setTimeout(() => finishAudio({ failed: false }), maxMs);
            return;
          } catch (_) {
            // Chuyển sang WebSpeech bên dưới nếu Audio gặp lỗi
          }
        }
        this._speakWithWebSpeechOrChime(cleanText, playRate, token, opts);
      });

      return {
        spoken: true,
        engine: 'neural-tts',
        voiceName: 'vi-VN-Neural',
        rate: playRate,
        lang: this.lang,
        text: cleanText
      };
    }

    // 2. Nhánh đồng bộ Web Speech API hoặc WebAudio Fallback (dùng khi offline hoặc trong unit test)
    return this._speakWithWebSpeechOrChime(cleanText, playRate, token, opts);
  }

  _speakWithWebSpeechOrChime(cleanText, playRate, token, opts = {}) {
    if (this._synth && typeof this._synth.speak === 'function') {
      try {
        const utter = this._utteranceFactory(cleanText);
        utter.lang = opts.lang || this.lang;
        utter.rate = playRate;
        utter.pitch = clamp(Number(opts.pitch ?? this.pitch), 0.5, 2.0);
        utter.volume = clamp(Number(opts.volume ?? this.volume), 0, 1);

        const voice = this.pickVoice();
        if (voice) utter.voice = voice;

        const finish = (failed = false) => {
          if (token !== this._speakToken) return;
          if (this._activeCancelEnd === opts.onEnd) {
            this._activeCancelEnd = null;
          }
          if (this._fallbackTimer) {
            clearTimeout(this._fallbackTimer);
            this._fallbackTimer = null;
          }
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this._emitState(cleanText);
          }
          opts.onEnd?.({ failed: Boolean(failed) });
        };

        utter.onend = () => finish(false);
        utter.onerror = () => finish(true);

        this._synth.speak(utter);

        const estimatedMs = Math.max(4000, Math.round((cleanText.length * 140) / playRate));
        this._fallbackTimer = setTimeout(() => finish(false), estimatedMs);

        return {
          spoken: true,
          engine: 'web-speech',
          voiceName: voice?.name || 'default',
          rate: playRate,
          lang: utter.lang,
          text: cleanText
        };
      } catch (_) {}
    }

    this._playGentleVoiceChime();
    const durationMs = clamp(Math.round((cleanText.length * 30) / playRate), 500, 3000);
    this._fallbackTimer = setTimeout(() => {
      if (token !== this._speakToken) return;
      if (this._activeCancelEnd === opts.onEnd) {
        this._activeCancelEnd = null;
      }
      this._fallbackTimer = null;
      this.isSpeaking = false;
      this._emitState(cleanText);
      opts.onEnd?.();
    }, durationMs);

    return {
      spoken: true,
      engine: 'webaudio-fallback',
      voiceName: 'synth-chime',
      rate: playRate,
      lang: this.lang,
      text: cleanText
    };
  }

  _playGentleVoiceChime() {
    try {
      const AudioCtx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AudioCtx) return;
      if (!this._audioCtx) this._audioCtx = new AudioCtx();
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.035, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (_) {}
  }

  _emitState(text = this.lastSpokenText) {
    if (typeof this.onStateChange === 'function') {
      try {
        this.onStateChange({
          isSpeaking: this.isSpeaking,
          enabled: this.enabled,
          rate: this.rate,
          text
        });
      } catch (_) {}
    }
  }
}
