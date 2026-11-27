extends SceneTree
# Kiểm tra file .glb xuất từ Studio khi import bằng Godot (chạy headless).
# Được gọi bởi tests/godot_import_check.sh — không cần mở editor.

var MODEL := ""
var failures: PackedStringArray = []

func fail(msg: String) -> void:
	failures.append(msg)
	print("FAIL  ", msg)

func ok(msg: String) -> void:
	print("ok    ", msg)

func find_class(node: Node, cls: String) -> Node:
	if node.is_class(cls):
		return node
	for child in node.get_children():
		var found := find_class(child, cls)
		if found != null:
			return found
	return null

func find_bone(skeleton: Skeleton3D, suffix: String) -> int:
	for b in skeleton.get_bone_count():
		if skeleton.get_bone_name(b).to_lower().ends_with(suffix):
			return b
	return -1

func _init() -> void:
	MODEL = OS.get_environment("GLB_MODEL")
	if MODEL.is_empty():
		MODEL = "res://model.glb"
	var min_tracks := int(OS.get_environment("GLB_MIN_TRACKS")) if OS.get_environment("GLB_MIN_TRACKS") != "" else 10
	var min_moving := int(OS.get_environment("GLB_MIN_MOVING_BONES")) if OS.get_environment("GLB_MIN_MOVING_BONES") != "" else 8

	print("== Godot ", Engine.get_version_info().string, " — import ", MODEL)

	var packed := load(MODEL) as PackedScene
	if packed == null:
		fail("không load được scene từ GLB")
		quit(1)
		return
	ok("load() trả PackedScene")

	var root := packed.instantiate()
	if root == null:
		fail("instantiate() thất bại")
		quit(1)
		return
	ok("instantiate() OK: %s" % root.name)

	var skeleton := find_class(root, "Skeleton3D") as Skeleton3D
	if skeleton == null:
		fail("không thấy Skeleton3D")
	else:
		ok("Skeleton3D: %d xương" % skeleton.get_bone_count())

	var mesh_nodes := root.find_children("*", "MeshInstance3D", true, false)
	var skinned := 0
	for m in mesh_nodes:
		if m is MeshInstance3D and (m as MeshInstance3D).skeleton != NodePath():
			skinned += 1
	if skinned == 0:
		fail("không có MeshInstance3D gắn skeleton")
	else:
		ok("SkinnedMesh: %d/%d MeshInstance3D" % [skinned, mesh_nodes.size()])

	var player := find_class(root, "AnimationPlayer") as AnimationPlayer
	if player == null:
		fail("không có AnimationPlayer — GLB không mang animation")
		quit(1)
		return

	var anims := player.get_animation_list()
	ok("AnimationPlayer: %d animation %s" % [anims.size(), str(anims)])
	if anims.size() == 0:
		fail("danh sách animation rỗng")
		quit(1)
		return

	var anim := player.get_animation(anims[0])
	ok("clip \"%s\" · %.3fs · %d track" % [anim.get_name(), anim.length, anim.get_track_count()])
	if anim.get_track_count() < min_tracks:
		fail("chỉ có %d track (cần >= %d) — track bị mất khi import" % [anim.get_track_count(), min_tracks])

	var base := player.get_node(player.root_node)
	var unresolved := 0
	for i in anim.get_track_count():
		if base.get_node_or_null(anim.track_get_path(i)) == null:
			unresolved += 1
	if unresolved > 0:
		fail("%d/%d track không giải được node" % [unresolved, anim.get_track_count()])
	else:
		ok("toàn bộ %d track giải được node" % anim.get_track_count())

	if skeleton == null:
		quit(1)
		return

	player.play(anims[0])
	player.seek(0.0, true)
	var snapshot: Array[Quaternion] = []
	for b in skeleton.get_bone_count():
		snapshot.append(skeleton.get_bone_pose_rotation(b))
	var hips := find_bone(skeleton, "hips")
	var p0 := Vector3.ZERO
	if hips >= 0:
		p0 = skeleton.get_bone_pose_position(hips)

	# Lấy mẫu nhiều mốc: clip dạng sin có thể trùng pose đầu ở đúng giữa clip.
	var changed := 0
	var hips_moved := 0.0
	for frac in [0.25, 0.5, 0.75]:
		player.seek(anim.length * frac, true)
		var moved_now := 0
		for b in skeleton.get_bone_count():
			if snapshot[b].angle_to(skeleton.get_bone_pose_rotation(b)) > 0.01:
				moved_now += 1
		changed = max(changed, moved_now)
		if hips >= 0:
			hips_moved = maxf(hips_moved, p0.distance_to(skeleton.get_bone_pose_position(hips)))
	print("      %d/%d xương xoay > 0.01 rad · hông dịch %.4f (đơn vị local)" % [changed, skeleton.get_bone_count(), hips_moved])

	if changed < min_moving:
		fail("quá ít xương chuyển động: %d (cần >= %d)" % [changed, min_moving])
	else:
		ok("%d xương cùng chuyển động" % changed)

	# Seek tới cuối clip phải khác giữa clip (không bị kẹt ở một pose).
	player.seek(anim.length * 0.9, true)
	var late := 0
	for b in skeleton.get_bone_count():
		if snapshot[b].angle_to(skeleton.get_bone_pose_rotation(b)) > 0.01:
			late += 1
	if late < min_moving / 2:
		fail("cuối clip chỉ %d xương còn khác pose đầu" % late)
	else:
		ok("cuối clip vẫn còn %d xương khác pose đầu" % late)

	if hips >= 0 and hips_moved < 0.01:
		fail("track vị trí hông không làm hông dịch chuyển")
	else:
		ok("track vị trí hông dịch %.4f (đơn vị local)" % hips_moved)

	root.free()

	print("")
	if failures.is_empty():
		print("GODOT IMPORT: ALL CHECKS PASSED")
		quit(0)
	else:
		print("GODOT IMPORT: %d CHECK(S) FAILED" % failures.size())
		quit(1)
