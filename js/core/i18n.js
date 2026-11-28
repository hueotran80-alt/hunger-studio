/**
 * File: js/core/i18n.js
 * Lightweight Vietnamese / English (VI / EN) internationalization helper for
 * Hunger 3D Studio, Hunger Motion workspace, Cloud Panel, and Feedback Dialog.
 *
 * Persists user preference in localStorage (`hunger_lang`) and supports `?lang=vi|en`.
 * Default language is `en` to stay deterministic across automated suites while
 * letting any user switch VI <-> EN in one click without page reload.
 */

const STORAGE_KEY = 'hunger_lang';
export const SUPPORTED_LANGS = Object.freeze(['en', 'vi']);

const STRINGS = {
  en: {
    // Top Menu Bar
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.add': 'Add',
    'menu.render': 'Render',
    'menu.help': 'Help',

    // File menu items
    'file.new': 'New Project',
    'file.open': 'Open Project (.blend.json / .wbs)',
    'file.save': 'Save Project (.blend.json)',
    'file.saveWbs': 'Save Package (.wbs)',
    'file.share': 'Share / Embed 3D...',
    'file.cloud': 'Cloud / Account...',
    'file.publish': 'Publish to Hunger Community...',
    'file.import': 'Import',
    'file.export': 'Export',
    'file.renderPng': 'Render Image (.png)',
    'file.renderTransparent': 'Render Transparent (.png)',
    'file.renderAnimation': 'Render Animation (Video)...',

    // Edit menu items
    'edit.undo': 'Undo',
    'edit.redo': 'Redo',
    'edit.duplicate': 'Duplicate Object',
    'edit.duplicateLinked': 'Duplicate Linked (0 Extra RAM)',
    'edit.batchGpu': 'Batch Selected to GPU Instances',
    'edit.delete': 'Delete Selected',
    'edit.group': 'Group Objects',
    'edit.ungroup': 'Ungroup',

    // Render menu items
    'render.viewport': 'Viewport Render Image',
    'render.transparent': 'Render with Transparent BG',
    'render.animation': 'Render Animation (Video)...',
    'render.pathtrace': 'Path Tracing (Cycles-Style)...',

    // Help menu items
    'help.shortcuts': 'Keyboard Shortcuts',
    'help.stem': 'STEM Curriculum & 1-on-1 Tutor',
    'help.ai': 'Open AI 3D Copilot',
    'help.aiSettings': 'AI Copilot Model Settings',
    'help.language': 'Language: English (Switch to Vietnamese)',
    'help.feedback': 'Send Beta Feedback...',
    'help.about': 'About Hunger',

    // Workspaces & Header
    'ws.motion': 'Motion',
    'ws.layout': 'Layout',
    'ws.viewport': 'Viewport (Full)',
    'ws.advanced': 'Advanced',
    'ws.modeling': 'Modeling',
    'ws.scripting': 'Scripting (DSL)',
    'ws.ai': 'AI 3D Studio',
    'header.feedback': 'Feedback',
    'header.feedbackTitle': 'Send Beta Feedback or Report a Bug',
    'header.langTitle': 'Switch Language (English / Vietnamese)',
    'header.objects': 'Objects:',
    'header.verts': 'Verts:',
    'header.faces': 'Faces:',
    'header.fps': 'FPS:',
    'header.frame': 'Frame:',

    // Bottom Dock & Side Panels
    'dock.panels': 'Panels ▾',
    'dock.scripting': 'Scripting',
    'dock.materials': 'Materials',
    'dock.pose': 'Pose',
    'dock.timeline': 'Timeline',
    'dock.physics': 'Physics',
    'dock.graph': 'Graph Editor',
    'dock.uv': 'UV Editor',
    'dock.mocap': 'AI Mocap',
    'dock.hunyuan': 'Image to 3D',
    'dock.stem': 'STEM Lab',
    'dock.shader': 'Shader Nodes',
    'dock.assets': 'Asset Library',

    // Motion / Mocap Workspace UI
    'mocap.clipEditor': 'Movie Clip Editor',
    'mocap.notAnalyzed': 'Not Analyzed',
    'mocap.ready': 'Ready',
    'mocap.noVideo': 'No Video',
    'mocap.emptyPrompt': 'Select a sample video or upload your own to begin analysis',
    'mocap.play': '▶ Play',
    'mocap.advancedTools': 'Advanced Tools',
    'mocap.fullPipeline': 'Analyze & Apply Full Video (100%)',
    'mocap.trackAi': '1. Track AI',
    'mocap.applyModel': '2. Apply to Model',
    'mocap.cancel': '✕ Cancel',
    'mocap.syncTimeline': 'Sync Studio Timeline',
    'mocap.skeleton2d': '2D Skeleton',
    'mocap.card1': 'Video Source & Target Character',
    'mocap.sourceVideo': 'Source Video',
    'mocap.load': 'Load',
    'mocap.uploadVideo': 'Upload Local Video (.mp4, .webm, .mov)',
    'mocap.uploadChar': 'Upload 3D Character (.glb, .vrm, .fbx, .obj)',
    'mocap.autoRig': 'Auto-Rig',
    'mocap.addRig': '+ Rig',
    'mocap.targetChar': 'Target 3D Character',
    'mocap.refresh': 'Refresh',
    'mocap.unriggedTag': 'Unrigged - Auto-Rig',
    'mocap.autoLoadPlaceholder': '(Auto-load Studio Athlete CC0 when clicking Analyze & Apply)',
    'mocap.rigNoChar': 'No character selected',
    'mocap.rigEmptyHint': 'Upload a custom .glb/.vrm/.fbx/.obj character or load a CC0 starter rig.',
    'mocap.rigUnrigged': 'Unrigged',
    'mocap.rigIncomplete': 'Missing key humanoid joints',
    'mocap.rigClickAutoRig': 'click Auto-Rig to bind a pro skeleton.',
    'mocap.rigStaticHint': 'Static 3D mesh detected. Click Auto-Rig to automatically fit a 56-bone humanoid skeleton.',
    'mocap.card2': 'Scope & Retarget Filtering',
    'mocap.engineMode': 'Inference Engine',
    'mocap.modelTier': 'AI Model Accuracy',
    'mocap.captureRange': 'Capture Range',
    'mocap.frameStep': 'Frame Step',
    'mocap.subjectMode': 'Single Subject Focus (Anti-Intruder)',
    'mocap.autoAlign': 'Auto-Align Facing',
    'mocap.floorContact': 'Floor Contact',
    'mocap.rootMotion': 'Root Hip Motion',
    'mocap.footLock': 'Foot-Lock IK',
    'mocap.handsFingers': 'Hands & Fingers',
    'mocap.faceExpr': 'Face & Expressions',
    'mocap.camComp': 'Cam Pan/Zoom Comp.',
    'mocap.smoothing': 'Motion Smoothing (SLERP)',
    'mocap.depthStab': 'Depth Stability Z (Anti-Twist)',
    'mocap.yawFront': '0° Front',
    'mocap.yawLeft': '-90° Left',
    'mocap.yawRight': '+90° Right',
    'mocap.yawBack': '180° Back',
    'mocap.card3': 'Export & Render 3D Video',
    'mocap.format': 'Format',
    'mocap.resolution': 'Resolution',
    'mocap.fps': 'FPS',
    'mocap.includeAudio': 'Include Source Audio / Music',
    'mocap.renderClip': 'Render Full 3D Clip',
    'mocap.autoCamera': 'Auto-Aim Camera',
    'mocap.followCamera': 'Follow Character',
    'mocap.cameraAngle': 'Camera View Angle',
    'mocap.cameraPitch': 'Camera Pitch Angle',
    'mocap.lensFov': 'Lens FOV',
    'mocap.distanceScale': 'Distance Scale',
    'mocap.fitCamera': 'Auto-Frame Camera',
    'mocap.exportGlb': '⬇ Export GLB',
    'mocap.exportBvh': '⬇ Export BVH',
    'mocap.exportFbx': '⬇ Export FBX',
    'mocap.card4': 'Manual Bone Posing (FK / IK)',
    'mocap.enablePosing': 'Enable Bone Posing',
    'mocap.rest': 'Rest',
    'mocap.mirror': 'Mirror',
    'mocap.loadMocap': 'Load Mocap',
    'mocap.exportPose': 'Export Pose',
    'mocap.bake': 'Bake',

    // Feedback Dialog
    'fb.title': 'Beta Feedback & Bug Report',
    'fb.category': 'Category',
    'fb.cat.bug': 'Bug report',
    'fb.cat.mocap': 'Mocap / Tracking',
    'fb.cat.export': 'GLB / Export',
    'fb.cat.performance': 'Performance / Load speed',
    'fb.cat.feature': 'Feature request',
    'fb.cat.other': 'Other',
    'fb.ratingLabel': 'Experience rating (optional, 1 = poor, 5 = great)',
    'fb.messageLabel': 'What happened or what should we improve?',
    'fb.placeholder': 'Describe the steps, video format, rig, or suggestion...',
    'fb.cancel': 'Cancel',
    'fb.submit': 'Send Feedback',
    'fb.sending': 'Sending feedback...',
    'fb.minChars': 'Please enter at least 3 characters.',
    'fb.success': 'Thank you. Your feedback has been recorded.',
    'fb.errorPrefix': 'Could not send feedback:',
    'fb.contextNote': 'No personal email or local files are uploaded.',

    // Cloud Panel
    'cp.title': 'Cloud Studio',
    'cp.tab.account': 'Account',
    'cp.tab.projects': 'Projects',
    'cp.tab.community': 'Community',
    'cp.tab.credits': 'Credits',
    'cp.authTitle': 'Account Sign In',
    'cp.oauthGoogle': 'Continue with Google',
    'cp.oauthGithub': 'Continue with GitHub',
    'cp.passwordLabel': 'Password (min 6 characters)',
    'cp.signIn': 'Sign In',
    'cp.signUp': 'Sign Up',
    'cp.magicLink': 'Send Magic Link',
    'cp.forgotPassword': 'Forgot Password',
    'cp.authHint': 'Sign in with email/password or a magic link. Use Forgot Password to send a recovery link to your email.',
    'cp.refresh': 'Refresh',
    'cp.changePassword': 'Change Password',
    'cp.exportData': 'Export Data',
    'cp.signOut': 'Sign Out',
    'cp.deleteAccount': 'Delete Account',

    // About / Shortcuts
    'about.title': 'About Hunger',
    'about.body':
      '3D web-native studio: modeling, rigging, AI mocap, animation, simulation, path tracing & interchange.\n' +
      'Familiar 3D workflow & shortcuts built for the web.\n\n' +
      'Open Help -> Keyboard Shortcuts to view the full searchable shortcut list.',
    'shortcuts.title': 'Hunger Shortcuts',
  },

  vi: {
    // Top Menu Bar
    'menu.file': 'Tệp',
    'menu.edit': 'Chỉnh sửa',
    'menu.add': 'Thêm',
    'menu.render': 'Kết xuất',
    'menu.help': 'Trợ giúp',

    // File menu items
    'file.new': 'Dự án mới',
    'file.open': 'Mở dự án (.blend.json / .wbs)',
    'file.save': 'Lưu dự án (.blend.json)',
    'file.saveWbs': 'Lưu gói dự án (.wbs)',
    'file.share': 'Chia sẻ / Nhúng 3D...',
    'file.cloud': 'Cloud / Tài khoản...',
    'file.publish': 'Đăng lên Cộng đồng Hunger...',
    'file.import': 'Nhập (Import)',
    'file.export': 'Xuất (Export)',
    'file.renderPng': 'Chụp ảnh khung nhìn (.png)',
    'file.renderTransparent': 'Chụp ảnh nền trong suốt (.png)',
    'file.renderAnimation': 'Xuất video hoạt cảnh...',

    // Edit menu items
    'edit.undo': 'Hoàn tác',
    'edit.redo': 'Làm lại',
    'edit.duplicate': 'Nhân bản đối tượng',
    'edit.duplicateLinked': 'Nhân bản liên kết (0 RAM thêm)',
    'edit.batchGpu': 'Gộp vùng chọn thành GPU Instances',
    'edit.delete': 'Xóa vùng chọn',
    'edit.group': 'Nhóm đối tượng',
    'edit.ungroup': 'Bỏ nhóm',

    // Render menu items
    'render.viewport': 'Kết xuất ảnh khung nhìn',
    'render.transparent': 'Kết xuất nền trong suốt',
    'render.animation': 'Kết xuất video hoạt cảnh...',
    'render.pathtrace': 'Path Tracing (Chuẩn Cycles)...',

    // Help menu items
    'help.shortcuts': 'Phím tắt bàn phím',
    'help.stem': 'Giáo trình STEM & Gia sư 1-1',
    'help.ai': 'Mở AI 3D Copilot',
    'help.aiSettings': 'Cài đặt mô hình AI Copilot',
    'help.language': 'Ngôn ngữ: Tiếng Việt (Chuyển sang English)',
    'help.feedback': 'Gửi góp ý / Báo lỗi Beta...',
    'help.about': 'Giới thiệu Hunger',

    // Workspaces & Header
    'ws.motion': 'Motion',
    'ws.layout': 'Bố cục',
    'ws.viewport': 'Toàn màn hình',
    'ws.advanced': 'Nâng cao',
    'ws.modeling': 'Dựng hình',
    'ws.scripting': 'Lập trình (DSL)',
    'ws.ai': 'AI 3D Studio',
    'header.feedback': 'Góp ý',
    'header.feedbackTitle': 'Gửi góp ý Beta hoặc báo lỗi',
    'header.langTitle': 'Đổi ngôn ngữ (Tiếng Việt / English)',
    'header.objects': 'Vật thể:',
    'header.verts': 'Đỉnh:',
    'header.faces': 'Mặt:',
    'header.fps': 'FPS:',
    'header.frame': 'Khung:',

    // Bottom Dock & Side Panels
    'dock.panels': 'Bảng công cụ ▾',
    'dock.scripting': 'Lập trình',
    'dock.materials': 'Vật liệu',
    'dock.pose': 'Tạo dáng',
    'dock.timeline': 'Dòng thời gian',
    'dock.physics': 'Vật lý',
    'dock.graph': 'Đồ thị F-Curve',
    'dock.uv': 'Biên tập UV',
    'dock.mocap': 'AI Mocap',
    'dock.hunyuan': 'Ảnh sang 3D',
    'dock.stem': 'Phòng lab STEM',
    'dock.shader': 'Nút vật liệu',
    'dock.assets': 'Thư viện tài sản',

    // Motion / Mocap Workspace UI
    'mocap.clipEditor': 'Trình chiếu video đầu vào',
    'mocap.notAnalyzed': 'Chưa phân tích',
    'mocap.ready': 'Sẵn sàng',
    'mocap.noVideo': 'Chưa có video',
    'mocap.emptyPrompt': 'Chọn video mẫu hoặc tải video từ máy để bắt đầu phân tích',
    'mocap.play': '▶ Phát',
    'mocap.advancedTools': 'Công cụ nâng cao',
    'mocap.fullPipeline': 'Phân tích & Áp dụng toàn bộ video (100%)',
    'mocap.trackAi': '1. Quét AI',
    'mocap.applyModel': '2. Áp lên nhân vật',
    'mocap.cancel': '✕ Hủy',
    'mocap.syncTimeline': 'Đồng bộ dòng thời gian',
    'mocap.skeleton2d': 'Khung xương 2D',
    'mocap.card1': 'Nguồn video & Nhân vật 3D',
    'mocap.sourceVideo': 'Video nguồn',
    'mocap.load': 'Nạp',
    'mocap.uploadVideo': 'Tải video từ máy (.mp4, .webm, .mov)',
    'mocap.uploadChar': 'Tải nhân vật 3D lên (.glb, .vrm, .fbx, .obj)',
    'mocap.autoRig': 'Tự gắn xương',
    'mocap.addRig': '+ Xương mẫu',
    'mocap.targetChar': 'Nhân vật 3D mục tiêu',
    'mocap.refresh': 'Làm mới',
    'mocap.unriggedTag': 'Chưa có xương - Tự gắn xương',
    'mocap.autoLoadPlaceholder': '(Tự tải Studio Athlete CC0 khi bấm Phân tích & Áp dụng)',
    'mocap.rigNoChar': 'Chưa chọn nhân vật',
    'mocap.rigEmptyHint': 'Tải nhân vật .glb/.vrm/.fbx/.obj từ máy hoặc nạp nhân vật mẫu CC0.',
    'mocap.rigUnrigged': 'Chưa có xương',
    'mocap.rigIncomplete': 'Thiếu khớp xương người quan trọng',
    'mocap.rigClickAutoRig': 'bấm Tự gắn xương để gắn khung xương chuẩn.',
    'mocap.rigStaticHint': 'Phát hiện lưới 3D tĩnh. Bấm Tự gắn xương để tự căn khớp 56 xương người.',
    'mocap.card2': 'Phạm vi & Bộ lọc chuyển động',
    'mocap.engineMode': 'Bộ xử lý suy luận',
    'mocap.modelTier': 'Độ chính xác mô hình AI',
    'mocap.captureRange': 'Phạm vi khung hình',
    'mocap.frameStep': 'Bước nhảy khung hình',
    'mocap.subjectMode': 'Khóa 1 chủ thể (Chống nhiễu người lạ)',
    'mocap.autoAlign': 'Tự căn hướng mặt',
    'mocap.floorContact': 'Chạm sàn tự động',
    'mocap.rootMotion': 'Chuyển động hông gốc',
    'mocap.footLock': 'Khóa chân IK chống trượt',
    'mocap.handsFingers': 'Bàn tay & Ngón tay',
    'mocap.faceExpr': 'Khuôn mặt & Biểu cảm',
    'mocap.camComp': 'Bù rung / lia máy quay',
    'mocap.smoothing': 'Làm mượt chuyển động (SLERP)',
    'mocap.depthStab': 'Ổn định chiều sâu Z (Chống xoắn)',
    'mocap.yawFront': '0° Trước',
    'mocap.yawLeft': '-90° Trái',
    'mocap.yawRight': '+90° Phải',
    'mocap.yawBack': '180° Sau',
    'mocap.card3': 'Xuất & Kết xuất video 3D',
    'mocap.format': 'Định dạng',
    'mocap.resolution': 'Độ phân giải',
    'mocap.fps': 'FPS',
    'mocap.includeAudio': 'Kèm âm thanh / nhạc video gốc',
    'mocap.renderClip': 'Kết xuất toàn bộ clip 3D',
    'mocap.autoCamera': 'Tự canh góc máy',
    'mocap.followCamera': 'Bám theo nhân vật',
    'mocap.cameraAngle': 'Góc đặt máy quay',
    'mocap.cameraPitch': 'Góc nghiêng máy quay',
    'mocap.lensFov': 'Tiêu cự FOV',
    'mocap.distanceScale': 'Khoảng cách máy',
    'mocap.fitCamera': 'Canh khung nhân vật',
    'mocap.exportGlb': '⬇ Xuất GLB',
    'mocap.exportBvh': '⬇ Xuất BVH',
    'mocap.exportFbx': '⬇ Xuất FBX',
    'mocap.card4': 'Chỉnh tư thế xương thủ công (FK / IK)',
    'mocap.enablePosing': 'Bật chỉnh xương',
    'mocap.rest': 'Mặc định',
    'mocap.mirror': 'Đối xứng',
    'mocap.loadMocap': 'Nạp Mocap',
    'mocap.exportPose': 'Xuất tư thế',
    'mocap.bake': 'Ghi Keyframe',

    // Feedback Dialog
    'fb.title': 'Góp ý Beta & Báo lỗi',
    'fb.category': 'Phân loại',
    'fb.cat.bug': 'Báo lỗi phần mềm',
    'fb.cat.mocap': 'Mocap / Quét chuyển động',
    'fb.cat.export': 'Xuất GLB / Hoạt cảnh',
    'fb.cat.performance': 'Hiệu năng / Tốc độ tải',
    'fb.cat.feature': 'Đề xuất tính năng',
    'fb.cat.other': 'Khác',
    'fb.ratingLabel': 'Đánh giá trải nghiệm (tùy chọn, 1 = chưa tốt, 5 = rất tốt)',
    'fb.messageLabel': 'Bạn gặp vấn đề gì hoặc muốn cải thiện điều gì?',
    'fb.placeholder': 'Mô tả các bước tái hiện, định dạng video, rig hoặc góp ý của bạn...',
    'fb.cancel': 'Hủy',
    'fb.submit': 'Gửi góp ý',
    'fb.sending': 'Đang gửi góp ý...',
    'fb.minChars': 'Vui lòng nhập ít nhất 3 ký tự.',
    'fb.success': 'Cảm ơn bạn. Góp ý của bạn đã được ghi nhận.',
    'fb.errorPrefix': 'Không gửi được góp ý:',
    'fb.contextNote': 'Không tự động tải lên email cá nhân hay tệp trên máy của bạn.',

    // Cloud Panel
    'cp.title': 'Cloud Studio',
    'cp.tab.account': 'Tài khoản',
    'cp.tab.projects': 'Dự án',
    'cp.tab.community': 'Cộng đồng',
    'cp.tab.credits': 'Credit',
    'cp.authTitle': 'Đăng nhập tài khoản',
    'cp.oauthGoogle': 'Tiếp tục với Google',
    'cp.oauthGithub': 'Tiếp tục với GitHub',
    'cp.passwordLabel': 'Mật khẩu (tối thiểu 6 ký tự)',
    'cp.signIn': 'Đăng nhập',
    'cp.signUp': 'Đăng ký',
    'cp.magicLink': 'Gửi link đăng nhập',
    'cp.forgotPassword': 'Quên mật khẩu',
    'cp.authHint': 'Đăng nhập bằng email/mật khẩu hoặc link đăng nhập nhanh. Chọn Quên mật khẩu để nhận link khôi phục qua email.',
    'cp.refresh': 'Làm mới',
    'cp.changePassword': 'Đổi mật khẩu',
    'cp.exportData': 'Xuất dữ liệu',
    'cp.signOut': 'Đăng xuất',
    'cp.deleteAccount': 'Xóa tài khoản',

    // About / Shortcuts
    'about.title': 'Giới thiệu Hunger',
    'about.body':
      'Studio 3D chạy trực tiếp trên trình duyệt: dựng hình, gắn xương, AI mocap, hoạt cảnh, mô phỏng vật lý và path tracing.\n' +
      'Quy trình thao tác và phím tắt quen thuộc chuẩn 3D tối ưu cho web.\n\n' +
      'Mở Trợ giúp -> Phím tắt bàn phím để xem đầy đủ danh sách phím tắt.',
    'shortcuts.title': 'Phím tắt Hunger',
  },
};

// Selector -> translation key mapping for static Studio shell & panels
const SELECTOR_MAP = [
  ['#menu-file > .menu-btn', 'menu.file'],
  ['#menu-edit > .menu-btn', 'menu.edit'],
  ['#menu-add > .menu-btn', 'menu.add'],
  ['#menu-render > .menu-btn', 'menu.render'],
  ['#menu-help > .menu-btn', 'menu.help'],
  ['#btn-file-new > span:first-child', 'file.new'],
  ['#btn-file-open > span:first-child', 'file.open'],
  ['#btn-file-save > span:first-child', 'file.save'],
  ['#btn-file-save-wbs > span:first-child', 'file.saveWbs'],
  ['#btn-file-share > span:first-child', 'file.share'],
  ['#btn-file-cloud > span:first-child', 'file.cloud'],
  ['#btn-file-publish > span:first-child', 'file.publish'],
  ['#menu-file-import > .dropdown-item > span:first-child', 'file.import'],
  ['#menu-file-export > .dropdown-item > span:first-child', 'file.export'],
  ['#btn-render-png > span:first-child', 'file.renderPng'],
  ['#btn-render-transparent > span:first-child', 'file.renderTransparent'],
  ['#btn-file-render-animation > span:first-child', 'file.renderAnimation'],
  ['#btn-edit-undo > span:first-child', 'edit.undo'],
  ['#btn-edit-redo > span:first-child', 'edit.redo'],
  ['#btn-edit-duplicate > span:first-child', 'edit.duplicate'],
  ['#btn-edit-duplicate-linked > span:first-child', 'edit.duplicateLinked'],
  ['#btn-edit-batch-gpu > span:first-child', 'edit.batchGpu'],
  ['#btn-edit-delete > span:first-child', 'edit.delete'],
  ['#btn-edit-group > span:first-child', 'edit.group'],
  ['#btn-edit-ungroup > span:first-child', 'edit.ungroup'],
  ['#btn-render-viewport > span:first-child', 'render.viewport'],
  ['#btn-render-transparent-menu > span:first-child', 'render.transparent'],
  ['#btn-render-animation > span:first-child', 'render.animation'],
  ['#btn-render-pathtrace > span:first-child', 'render.pathtrace'],
  ['#btn-help-shortcuts > span:first-child', 'help.shortcuts'],
  ['#btn-help-stem-tutor > span:first-child', 'help.stem'],
  ['#btn-help-ai > span:first-child', 'help.ai'],
  ['#btn-help-ai-settings > span:first-child', 'help.aiSettings'],
  ['#btn-help-lang > span:first-child', 'help.language'],
  ['#btn-help-feedback > span:first-child', 'help.feedback'],
  ['#btn-help-about > span:first-child', 'help.about'],
  ['.workspace-tab[data-workspace="motion"]', 'ws.motion'],
  ['.workspace-tab[data-workspace="layout"]', 'ws.layout'],
  ['.workspace-tab[data-workspace="viewport"]', 'ws.viewport'],
  ['#tab-workspace-advanced', 'ws.advanced'],
  ['.workspace-tab[data-workspace="modeling"]', 'ws.modeling'],
  ['.workspace-tab[data-workspace="scripting"]', 'ws.scripting'],
  ['.workspace-tab[data-workspace="ai"]', 'ws.ai'],
  ['#btn-beta-feedback', 'header.feedback'],
  ['#btn-dock-tabs-menu', 'dock.panels'],
  // Mocap / Motion workspace buttons & labels
  ['#btn-mocap-open-advanced', 'mocap.advancedTools'],
  ['#btn-mocap-full-pipeline > span', 'mocap.fullPipeline'],
  ['#btn-mocap-track > span', 'mocap.trackAi'],
  ['#btn-mocap-apply > span', 'mocap.applyModel'],
  ['#btn-mocap-cancel', 'mocap.cancel'],
  ['label[for="mocap-video-preset"]', 'mocap.sourceVideo'],
  ['#btn-mocap-load-preset', 'mocap.load'],
  ['label[for="mocap-target-character"]', 'mocap.targetChar'],
  ['#btn-mocap-refresh-targets', 'mocap.refresh'],
  ['label[for="mocap-engine-mode"]', 'mocap.engineMode'],
  ['label[for="mocap-model-tier"]', 'mocap.modelTier'],
  ['label[for="mocap-max-frames"]', 'mocap.captureRange'],
  ['label[for="mocap-frame-step"]', 'mocap.frameStep'],
  ['label[for="mocap-subject-mode"]', 'mocap.subjectMode'],
  ['.mp-chip[data-yaw="0"]', 'mocap.yawFront'],
  ['.mp-chip[data-yaw="-90"]', 'mocap.yawLeft'],
  ['.mp-chip[data-yaw="90"]', 'mocap.yawRight'],
  ['.mp-chip[data-yaw="180"]', 'mocap.yawBack'],
  ['label[for="mocap-render-format"]', 'mocap.format'],
  ['label[for="mocap-render-res"]', 'mocap.resolution'],
  ['label[for="mocap-render-fps"]', 'mocap.fps'],
  ['#btn-mocap-render', 'mocap.renderClip'],
  ['label[for="mocap-camera-preset"]', 'mocap.cameraAngle'],
  ['#btn-mocap-fit-camera', 'mocap.fitCamera'],
  ['#btn-mocap-export-glb', 'mocap.exportGlb'],
  ['#btn-mocap-export-bvh', 'mocap.exportBvh'],
  ['#btn-mocap-export-fbx', 'mocap.exportFbx'],
  ['#btn-pose-edit-toggle', 'mocap.enablePosing'],
  ['#btn-pose-edit-reset', 'mocap.rest'],
  ['#btn-pose-edit-mirror', 'mocap.mirror'],
  ['#btn-pose-edit-load-mocap', 'mocap.loadMocap'],
  ['#btn-pose-edit-export', 'mocap.exportPose'],
  ['#btn-pose-edit-bake', 'mocap.bake'],
  // Cloud Panel static controls
  ['#cp-title', 'cp.title'],
  ['.cp-tab[data-tab="account"]', 'cp.tab.account'],
  ['.cp-tab[data-tab="projects"]', 'cp.tab.projects'],
  ['.cp-tab[data-tab="community"]', 'cp.tab.community'],
  ['.cp-tab[data-tab="credits"]', 'cp.tab.credits'],
  ['#cp-auth-supabase .cp-section-title', 'cp.authTitle'],
  ['#cp-sb-oauth-google', 'cp.oauthGoogle'],
  ['#cp-sb-oauth-github', 'cp.oauthGithub'],
  ['#cp-sb-signin', 'cp.signIn'],
  ['#cp-sb-signup', 'cp.signUp'],
  ['#cp-sb-magic', 'cp.magicLink'],
  ['#cp-sb-reset', 'cp.forgotPassword'],
  ['#cp-refresh', 'cp.refresh'],
  ['#cp-toggle-password', 'cp.changePassword'],
  ['#cp-export-data', 'cp.exportData'],
  ['#cp-logout', 'cp.signOut'],
  ['#cp-delete-account', 'cp.deleteAccount'],
];

const listeners = new Set();
let currentLang = detectInitialLang();

export function normalizeLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'vi' || s.startsWith('vi-')) return 'vi';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return null;
}

function detectInitialLang() {
  try {
    if (typeof location !== 'undefined' && location.search) {
      const q = normalizeLang(new URLSearchParams(location.search).get('lang'));
      if (q) {
        try { localStorage.setItem(STORAGE_KEY, q); } catch (_) {}
        return q;
      }
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = normalizeLang(localStorage.getItem(STORAGE_KEY));
      if (saved) return saved;
    }
  } catch (_) {}
  return 'en';
}

export function getLang() {
  return currentLang;
}

export function t(key, fallback = '') {
  const dict = STRINGS[currentLang] || STRINGS.en;
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  if (Object.prototype.hasOwnProperty.call(STRINGS.en, key)) return STRINGS.en[key];
  return fallback || key;
}

export function setLang(nextLang, { persist = true, apply = true } = {}) {
  const normalized = normalizeLang(nextLang);
  if (!normalized) return currentLang;
  currentLang = normalized;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, currentLang); } catch (_) {}
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = currentLang;
    if (apply) applyTranslations(document);
  }
  for (const fn of listeners) {
    try { fn(currentLang); } catch (_) {}
  }
  return currentLang;
}

export function toggleLang() {
  return setLang(currentLang === 'vi' ? 'en' : 'vi');
}

export function onLangChange(callback) {
  if (typeof callback !== 'function') return () => {};
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function setTextKeepingChildElements(el, text) {
  if (!el) return;
  let updated = false;
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) {
      node.nodeValue = ` ${text} `;
      updated = true;
      break;
    }
  }
  if (!updated) el.textContent = text;
}

export function applyTranslations(root = typeof document !== 'undefined' ? document : null) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  if (typeof document !== 'undefined') {
    document.documentElement.lang = currentLang;
  }

  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key, el.textContent);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key, el.getAttribute('title') || ''));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key, el.getAttribute('placeholder') || ''));
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key, el.getAttribute('aria-label') || ''));
  }

  for (const [selector, key] of SELECTOR_MAP) {
    const el = root.querySelector(selector);
    if (el) el.textContent = t(key, el.textContent);
  }

  // Checkbox labels that contain an <input> plus a text node
  const checkboxLabels = [
    ['#mocap-sync-timeline', 'mocap.syncTimeline'],
    ['#mocap-show-overlay', 'mocap.skeleton2d'],
    ['#mocap-auto-align', 'mocap.autoAlign'],
    ['#mocap-ground-feet', 'mocap.floorContact'],
    ['#mocap-root-motion', 'mocap.rootMotion'],
    ['#mocap-foot-lock', 'mocap.footLock'],
    ['#mocap-track-hands', 'mocap.handsFingers'],
    ['#mocap-track-face', 'mocap.faceExpr'],
    ['#mocap-cam-comp', 'mocap.camComp'],
    ['#mocap-render-audio', 'mocap.includeAudio'],
    ['#mocap-auto-camera', 'mocap.autoCamera'],
    ['#mocap-follow-camera', 'mocap.followCamera'],
  ];
  for (const [inputSel, key] of checkboxLabels) {
    const input = root.querySelector(inputSel);
    if (input?.parentElement) {
      setTextKeepingChildElements(input.parentElement, t(key));
    }
  }

  const feedbackBtn = root.querySelector('#btn-beta-feedback');
  if (feedbackBtn) feedbackBtn.setAttribute('title', t('header.feedbackTitle'));

  const langBtn = root.querySelector('#btn-lang-toggle');
  if (langBtn) {
    langBtn.setAttribute('title', t('header.langTitle'));
    langBtn.setAttribute('data-lang', currentLang);
    for (const pill of langBtn.querySelectorAll('[data-lang-opt]')) {
      pill.classList.toggle('active', pill.getAttribute('data-lang-opt') === currentLang);
    }
  }
}

export const __i18nInternals = {
  STORAGE_KEY,
  STRINGS,
  SELECTOR_MAP,
};
