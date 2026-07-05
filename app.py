import os
import re

import dash_bootstrap_components as dbc
from dash import ALL, Dash, Input, Output, State, ctx, dcc, html, no_update
from dash.dependencies import ClientsideFunction

# --------------------------------------------------------------------------
# Asset discovery — anything dropped into assets/hype or assets/fx shows up
# automatically as a button next time the app starts.
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HYPE_DIR = os.path.join(BASE_DIR, "assets", "hype")
FX_DIR = os.path.join(BASE_DIR, "assets", "fx")
AUDIO_EXTS = (".mp3", ".wav", ".ogg", ".m4a")


def natural_sort_key(fname):
    # Splits "10.mp3" into ["", 10, ".mp3"] so numeric filenames sort as
    # 1, 2, 3 ... 10 instead of lexicographically (1, 10, 2, 3 ...).
    name = os.path.splitext(fname)[0]
    parts = re.split(r"(\d+)", name)
    return [int(p) if p.isdigit() else p.lower() for p in parts]


def scan_audio_folder(folder):
    if not os.path.isdir(folder):
        return []
    files = [f for f in os.listdir(folder) if f.lower().endswith(AUDIO_EXTS)]
    return sorted(files, key=natural_sort_key)


def label_from_filename(fname):
    name = os.path.splitext(fname)[0]
    return name.replace("_", " ").replace("-", " ").title()


def format_mmss(total_seconds):
    m, s = divmod(int(total_seconds), 60)
    return f"{m:02d}:{s:02d}"


HYPE_FILES = scan_audio_folder(HYPE_DIR)
FX_FILES = scan_audio_folder(FX_DIR)

# (label, beats, subdivisions) — all combos are "1 subdivision", i.e. one
# hit per quarter-note beat, matching your original Easy Metronome settings.
COMBOS = [
    ("2-hit", 2, 1),
    ("3-hit", 3, 1),
    ("4-hit", 4, 1),
    ("5-hit", 5, 1),
]
COMBO_LABELS = {beats: name.upper() for name, beats, _ in COMBOS}

# --------------------------------------------------------------------------
# App setup
# --------------------------------------------------------------------------
app = Dash(__name__, external_stylesheets=[dbc.themes.CYBORG], update_title=None)
app.title = "Beat Box"
server = app.server  # needed for Heroku (gunicorn app:server)

default_fx_file = FX_FILES[0] if FX_FILES else None
default_fx_url = app.get_asset_url(f"fx/{default_fx_file}") if default_fx_file else None

INITIAL_STATE = {
    "bpm": 140,
    "beats": 3,
    "subdivisions": 1,
    "combo_label": COMBO_LABELS[3],
    "fx_url": default_fx_url,
    "hype_url": None,
    "mix": 50,  # 0 = metronome only, 100 = music only
    "running": False,
    "rounds": 1,
    "round_minutes": 1,
    "break_seconds": 30,
    "reset_token": 0,
}

# --------------------------------------------------------------------------
# Modal builders
# --------------------------------------------------------------------------


def build_combo_modal():
    buttons = [
        dbc.Button(name.upper(), id=f"combo-btn-{beats}", className="neon-btn m-2", n_clicks=0)
        for name, beats, _ in COMBOS
    ]
    return dbc.Modal(
        [
            dbc.ModalHeader(dbc.ModalTitle("Select Combo")),
            dbc.ModalBody(html.Div(buttons, className="button-row")),
        ],
        id="modal-combo",
        is_open=False,
        centered=True,
    )


def build_bpm_modal():
    return dbc.Modal(
        [
            dbc.ModalHeader(dbc.ModalTitle("BPM")),
            dbc.ModalBody(
                [
                    html.Div(f"{INITIAL_STATE['bpm']} BPM", id="bpm-value-display", className="combo-label"),
                    dcc.Slider(
                        id="bpm-slider",
                        min=100,
                        max=230,
                        step=10,
                        value=INITIAL_STATE["bpm"],
                        marks={i: str(i) for i in range(100, 231, 20)},
                    ),
                ]
            ),
            dbc.ModalFooter(dbc.Button("Close", id="bpm-close-btn", className="neon-btn neon-btn-magenta")),
        ],
        id="modal-bpm",
        is_open=False,
        centered=True,
    )


def build_hype_modal():
    buttons = [dbc.Button("OFF", id="hype-off-btn", className="neon-btn neon-btn-magenta m-2", n_clicks=0)]
    buttons += [
        dbc.Button(label_from_filename(f), id={"type": "hype-btn", "index": f}, className="neon-btn m-2", n_clicks=0)
        for f in HYPE_FILES
    ]
    if not HYPE_FILES:
        buttons.append(html.Div("No files found in assets/hype/", className="combo-label"))
    return dbc.Modal(
        [
            dbc.ModalHeader(dbc.ModalTitle("Hype Music")),
            dbc.ModalBody(html.Div(buttons, className="button-row")),
        ],
        id="modal-hype",
        is_open=False,
        centered=True,
    )


def build_fx_modal():
    buttons = [
        dbc.Button(label_from_filename(f), id={"type": "fx-btn", "index": f}, className="neon-btn m-2", n_clicks=0)
        for f in FX_FILES
    ]
    if not FX_FILES:
        buttons = [html.Div("No files found in assets/fx/", className="combo-label")]
    return dbc.Modal(
        [
            dbc.ModalHeader(dbc.ModalTitle("Metronome Sound")),
            dbc.ModalBody(html.Div(buttons, className="button-row")),
        ],
        id="modal-fx",
        is_open=False,
        centered=True,
    )


def build_mix_modal():
    return dbc.Modal(
        [
            dbc.ModalHeader(dbc.ModalTitle("Mix")),
            dbc.ModalBody(
                [
                    html.Div("METRONOME <-------> MUSIC", className="combo-label"),
                    dcc.Slider(
                        id="mix-slider",
                        min=0,
                        max=100,
                        step=1,
                        value=INITIAL_STATE["mix"],
                        marks={0: "METRO", 50: "50/50", 100: "MUSIC"},
                    ),
                ]
            ),
            dbc.ModalFooter(dbc.Button("Close", id="mix-close-btn", className="neon-btn neon-btn-magenta")),
        ],
        id="modal-mix",
        is_open=False,
        centered=True,
    )


def build_program_modal():
    return dbc.Modal(
        [
            dbc.ModalHeader(dbc.ModalTitle("Program")),
            dbc.ModalBody(
                [
                    html.Div(f"{INITIAL_STATE['rounds']} ROUND(S)", id="program-rounds-display", className="combo-label"),
                    dcc.Slider(
                        id="program-rounds-slider",
                        min=1,
                        max=15,
                        step=1,
                        value=INITIAL_STATE["rounds"],
                        marks={i: str(i) for i in range(1, 16, 2)},
                    ),
                    html.Div("ROUND LENGTH", className="combo-label", style={"marginTop": "1.5rem"}),
                    html.Div(
                        f"{INITIAL_STATE['round_minutes']} MIN SELECTED",
                        id="program-round-min-display",
                        className="combo-label",
                    ),
                    html.Div(
                        [
                            dbc.Button("1 MIN", id="program-round-min-1", className="neon-btn m-2", n_clicks=0),
                            dbc.Button("2 MIN", id="program-round-min-2", className="neon-btn m-2", n_clicks=0),
                            dbc.Button("3 MIN", id="program-round-min-3", className="neon-btn m-2", n_clicks=0),
                        ],
                        className="button-row",
                    ),
                    html.Div(
                        f"{INITIAL_STATE['break_seconds']} SEC BREAK",
                        id="program-break-display",
                        className="combo-label",
                        style={"marginTop": "1.5rem"},
                    ),
                    dcc.Slider(
                        id="program-break-slider",
                        min=10,
                        max=60,
                        step=5,
                        value=INITIAL_STATE["break_seconds"],
                        marks={i: str(i) for i in range(10, 61, 10)},
                    ),
                ]
            ),
            dbc.ModalFooter(dbc.Button("Close", id="program-close-btn", className="neon-btn neon-btn-magenta")),
        ],
        id="modal-program",
        is_open=False,
        centered=True,
    )


# --------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------
app.layout = dbc.Container(
    [
        dcc.Store(id="state-store", data=INITIAL_STATE),
        dcc.Interval(id="beat-poll-interval", interval=100, n_intervals=0),
        html.Div(id="audio-engine-dummy", style={"display": "none"}),
        html.Div("BEAT BOX", className="app-title", style={'marginBottom': '30px'},),
        html.Div(
            [
                html.Div(
                    [
                        html.Div(INITIAL_STATE["combo_label"], id="combo-label-display", className="combo-label"),
                        html.Div("--", id="beat-display", className="beat-display"),
                    ],
                    className="display-col display-col-left",
                ),
                html.Div(
                    [
                        html.Div(
                            f"ROUND 1/{INITIAL_STATE['rounds']}",
                            id="round-status-display",
                            className="round-status",
                        ),
                        html.Div(
                            format_mmss(INITIAL_STATE["round_minutes"] * 60),
                            id="round-timer-display",
                            className="round-timer round-timer-blue",
                        ),
                    ],
                    className="display-col display-col-center",
                ),
                html.Div(
                    [
                        html.Div("PUNCHES", className="combo-label"),
                        html.Div("0", id="total-punches-display", className="total-punches"),
                    ],
                    className="display-col display-col-right",
                ),
            ],
            className="display-row",
        ),
        html.Div(
            [
                dbc.Button("START", id="btn-start-stop", className="control-btn neon-btn neon-btn-green", n_clicks=0),
                dbc.Button("RESET", id="btn-reset", className="control-btn neon-btn neon-btn-yellow", n_clicks=0),
            ],
            className="primary-controls-row",
            style={'marginTop': '40px', 'marginBottom': '40px'},
        ),
        html.Div(
            [
                dbc.Button("PROGRAM", id="btn-program", className="neon-btn m-2", n_clicks=0),
                dbc.Button("COMBO", id="btn-combo", className="neon-btn m-2", n_clicks=0),
                dbc.Button("BPM", id="btn-bpm", className="neon-btn m-2", n_clicks=0),
            ],
            className="button-row",
            style={'marginBottom': '20px'},
        ),
        html.Div(
            [
                dbc.Button("HYPE", id="btn-hype", className="neon-btn neon-btn-magenta m-2", n_clicks=0),
                dbc.Button("FX", id="btn-fx", className="neon-btn neon-btn-magenta m-2", n_clicks=0),
                dbc.Button("MIX", id="btn-mix", className="neon-btn m-2", n_clicks=0),
            ],
            className="button-row",
            #style={'marginTop': '40px', 'marginBottom': '40px'},
        ),
        build_combo_modal(),
        build_bpm_modal(),
        build_hype_modal(),
        build_fx_modal(),
        build_mix_modal(),
        build_program_modal(),
    ],
    fluid=True,
    style={"paddingBottom": "4rem"},
)

# --------------------------------------------------------------------------
# Modal open/close callbacks
# --------------------------------------------------------------------------


@app.callback(
    Output("modal-combo", "is_open"),
    Input("btn-combo", "n_clicks"),
    Input("combo-btn-2", "n_clicks"),
    Input("combo-btn-3", "n_clicks"),
    Input("combo-btn-4", "n_clicks"),
    Input("combo-btn-5", "n_clicks"),
    State("modal-combo", "is_open"),
    prevent_initial_call=True,
)
def toggle_combo_modal(_o, _2, _3, _4, _5, is_open):
    if ctx.triggered_id == "btn-combo":
        return not is_open
    return False


@app.callback(
    Output("modal-bpm", "is_open"),
    Input("btn-bpm", "n_clicks"),
    Input("bpm-close-btn", "n_clicks"),
    State("modal-bpm", "is_open"),
    prevent_initial_call=True,
)
def toggle_bpm_modal(_o, _c, is_open):
    if ctx.triggered_id == "btn-bpm":
        return not is_open
    return False


@app.callback(
    Output("modal-hype", "is_open"),
    Input("btn-hype", "n_clicks"),
    Input("hype-off-btn", "n_clicks"),
    Input({"type": "hype-btn", "index": ALL}, "n_clicks"),
    State("modal-hype", "is_open"),
    prevent_initial_call=True,
)
def toggle_hype_modal(_o, _off, _sel, is_open):
    if ctx.triggered_id == "btn-hype":
        return not is_open
    return False


@app.callback(
    Output("modal-fx", "is_open"),
    Input("btn-fx", "n_clicks"),
    Input({"type": "fx-btn", "index": ALL}, "n_clicks"),
    State("modal-fx", "is_open"),
    prevent_initial_call=True,
)
def toggle_fx_modal(_o, _sel, is_open):
    if ctx.triggered_id == "btn-fx":
        return not is_open
    return False


@app.callback(
    Output("modal-mix", "is_open"),
    Input("btn-mix", "n_clicks"),
    Input("mix-close-btn", "n_clicks"),
    State("modal-mix", "is_open"),
    prevent_initial_call=True,
)
def toggle_mix_modal(_o, _c, is_open):
    if ctx.triggered_id == "btn-mix":
        return not is_open
    return False


@app.callback(
    Output("modal-program", "is_open"),
    Input("btn-program", "n_clicks"),
    Input("program-close-btn", "n_clicks"),
    State("modal-program", "is_open"),
    prevent_initial_call=True,
)
def toggle_program_modal(_o, _c, is_open):
    if ctx.triggered_id == "btn-program":
        return not is_open
    return False


# --------------------------------------------------------------------------
# State-updating callbacks (all share the state-store Output, hence
# allow_duplicate=True on every one of them)
# --------------------------------------------------------------------------


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("combo-btn-2", "n_clicks"),
    Input("combo-btn-3", "n_clicks"),
    Input("combo-btn-4", "n_clicks"),
    Input("combo-btn-5", "n_clicks"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def select_combo(_2, _3, _4, _5, data):
    # NOTE: Combo only sets the pattern now — it no longer starts the
    # metronome. Use Start/Stop for that.
    beats = int(ctx.triggered_id.split("-")[-1])
    data = dict(data)
    data["beats"] = beats
    data["subdivisions"] = 1
    data["combo_label"] = COMBO_LABELS[beats]
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("bpm-slider", "value"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def update_bpm(value, data):
    data = dict(data)
    data["bpm"] = value
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input({"type": "hype-btn", "index": ALL}, "n_clicks"),
    Input("hype-off-btn", "n_clicks"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def select_hype(_clicks, _off, data):
    trig = ctx.triggered_id
    data = dict(data)
    if trig == "hype-off-btn":
        data["hype_url"] = None
    elif isinstance(trig, dict):
        data["hype_url"] = app.get_asset_url(f"hype/{trig['index']}")
    else:
        return no_update
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input({"type": "fx-btn", "index": ALL}, "n_clicks"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def select_fx(_clicks, data):
    trig = ctx.triggered_id
    if isinstance(trig, dict):
        data = dict(data)
        data["fx_url"] = app.get_asset_url(f"fx/{trig['index']}")
        return data
    return no_update


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("mix-slider", "value"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def update_mix(value, data):
    data = dict(data)
    data["mix"] = value
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("btn-start-stop", "n_clicks"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def toggle_running(_n, data):
    data = dict(data)
    data["running"] = not data.get("running", False)
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("btn-reset", "n_clicks"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def reset_app(_n, data):
    data = dict(data)
    data["running"] = False
    data["reset_token"] = data.get("reset_token", 0) + 1
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("program-rounds-slider", "value"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def update_rounds(value, data):
    data = dict(data)
    data["rounds"] = value
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("program-round-min-1", "n_clicks"),
    Input("program-round-min-2", "n_clicks"),
    Input("program-round-min-3", "n_clicks"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def update_round_minutes(_1, _2, _3, data):
    minutes = int(ctx.triggered_id.split("-")[-1])
    data = dict(data)
    data["round_minutes"] = minutes
    return data


@app.callback(
    Output("state-store", "data", allow_duplicate=True),
    Input("program-break-slider", "value"),
    State("state-store", "data"),
    prevent_initial_call=True,
)
def update_break_seconds(value, data):
    data = dict(data)
    data["break_seconds"] = value
    return data


# --------------------------------------------------------------------------
# Pure display-sync callbacks (no duplicate-output concerns)
# --------------------------------------------------------------------------


@app.callback(
    Output("btn-start-stop", "children"),
    Output("btn-start-stop", "className"),
    Input("state-store", "data"),
)
def sync_start_button(data):
    running = data.get("running", False)
    if running:
        return "STOP", "control-btn neon-btn neon-btn-red"
    return "START", "control-btn neon-btn neon-btn-green"


@app.callback(
    Output("combo-label-display", "children"),
    Input("state-store", "data"),
)
def sync_combo_label(data):
    return data.get("combo_label", "")


@app.callback(
    Output("bpm-value-display", "children"),
    Input("bpm-slider", "value"),
)
def sync_bpm_display(value):
    return f"{value} BPM"


@app.callback(
    Output("program-rounds-display", "children"),
    Input("program-rounds-slider", "value"),
)
def sync_rounds_display(value):
    return f"{value} ROUND" + ("S" if value != 1 else "")


@app.callback(
    Output("program-break-display", "children"),
    Input("program-break-slider", "value"),
)
def sync_break_display(value):
    return f"{value} SEC BREAK"


@app.callback(
    Output("program-round-min-display", "children"),
    Input("state-store", "data"),
)
def sync_round_min_display(data):
    return f"{data.get('round_minutes', 1)} MIN SELECTED"


@app.callback(
    Output("beat-poll-interval", "disabled"),
    Input("state-store", "data"),
)
def toggle_poll_interval(data):
    # Only poll for live display updates while the metronome is running.
    return not data.get("running", False)


# --------------------------------------------------------------------------
# Clientside audio + program engine (see assets/metronome.js)
# --------------------------------------------------------------------------

app.clientside_callback(
    ClientsideFunction(namespace="clientside", function_name="updateAudioEngine"),
    Output("audio-engine-dummy", "children"),
    Output("round-timer-display", "children", allow_duplicate=True),
    Output("round-timer-display", "className", allow_duplicate=True),
    Output("round-status-display", "children", allow_duplicate=True),
    Output("total-punches-display", "children", allow_duplicate=True),
    Output("beat-display", "children", allow_duplicate=True),
    Output("beat-display", "className", allow_duplicate=True),
    Input("state-store", "data"),
    prevent_initial_call=True,
)

app.clientside_callback(
    ClientsideFunction(namespace="clientside", function_name="pollDisplay"),
    Output("beat-display", "children", allow_duplicate=True),
    Output("beat-display", "className", allow_duplicate=True),
    Output("round-timer-display", "children", allow_duplicate=True),
    Output("round-timer-display", "className", allow_duplicate=True),
    Output("round-status-display", "children", allow_duplicate=True),
    Output("total-punches-display", "children", allow_duplicate=True),
    Output("state-store", "data", allow_duplicate=True),
    Input("beat-poll-interval", "n_intervals"),
    State("state-store", "data"),
    prevent_initial_call=True,
)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8050, debug=False)
