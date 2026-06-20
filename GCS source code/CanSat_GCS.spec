# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec file for CanSat GCS
# Bundles server.py + public/ folder into a single .exe

import os

block_cipher = None

# Collect all files in public/ directory
public_dir = os.path.join(os.path.dirname(os.path.abspath(SPEC)), 'public')
public_datas = []

for root, dirs, files in os.walk(public_dir):
    for f in files:
        src = os.path.join(root, f)
        # Destination path relative to the bundle root
        dst = os.path.relpath(root, os.path.dirname(public_dir))
        public_datas.append((src, dst))

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[],
    datas=public_datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', '_tkinter', 'unittest', 'test'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='CanSat_GCS',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
