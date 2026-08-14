extends Node
# Junkstronaut generated content — written by content/run-content.js.
#
# Autoload this as `Content`. The three JSON files beside it are the pipeline's output and
# are safe to overwrite with a fresh run; nothing here holds state.

const DIR := "res://content/"

var barks := {}       # state id -> line
var debris := {}      # debris id -> { display_name, flavour }
var screens := {}     # terminal state id -> { title, cause, rule_broken, armstrong }

func _ready() -> void:
	for entry in _load("armstrong_barks.json").get("barks", []):
		barks[entry["id"]] = entry["line"]
	debris = _load("debris_flavour.json").get("pieces", {})
	screens = _load("postmortem_screens.json").get("screens", {})

func bark(state_id: String) -> String:
	return barks.get(state_id, "")

func display_name(debris_id: String) -> String:
	return debris.get(debris_id, {}).get("display_name", debris_id)

func _load(file_name: String) -> Dictionary:
	var f := FileAccess.open(DIR + file_name, FileAccess.READ)
	if f == null:
		push_error("content: could not open " + file_name)
		return {}
	var parsed: Variant = JSON.parse_string(f.get_as_text())
	return parsed if parsed is Dictionary else {}
