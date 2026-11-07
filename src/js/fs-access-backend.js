/* global normalizeVPath */
/* exported FileSystemAccessBackend */

class FileSystemAccessBackend {
  constructor(rootHandle, label) {
    this.rootHandle = rootHandle;
    this.modeName = "Playdate Data Disk";
    this.targetDescription = label || rootHandle.name;
  }

  static async resolveCrossPointDataHandle(pickedHandle) {
    const entries = [];
    for await (const [name, handle] of pickedHandle.entries()) {
      entries.push({ name, handle });
    }
    const findAppDirIn = async (dirHandle, prefixLabel) => {
      const candidates = [];
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === "directory" && name.includes("com.crosspoint.reader")) {
          let hasDotCp = false;
          try {
            await handle.getDirectoryHandle(".crosspoint");
            hasDotCp = true;
          } catch {
            // Directory does not have .crosspoint yet
          }
          candidates.push({ name, handle, hasDotCp, isUser: name.startsWith("user.") });
        }
      }
      if (candidates.length > 0) {
        candidates.sort(
          (a, b) =>
            Number(b.hasDotCp) - Number(a.hasDotCp) || Number(b.isUser) - Number(a.isUser),
        );
        return {
          handle: candidates[0].handle,
          label: `${prefixLabel}/${candidates[0].name}`,
        };
      }
      const created = await dirHandle.getDirectoryHandle("com.crosspoint.reader", {
        create: true,
      });
      return { handle: created, label: `${prefixLabel}/com.crosspoint.reader` };
    };

    if (
      pickedHandle.name.includes("com.crosspoint.reader") ||
      entries.some((e) => e.name === ".crosspoint")
    ) {
      return { handle: pickedHandle, label: pickedHandle.name };
    }
    const dataSub = entries.find(
      (e) => e.handle.kind === "directory" && e.name.toLowerCase() === "data",
    );
    if (dataSub) {
      return await findAppDirIn(dataSub.handle, `${pickedHandle.name}/Data`);
    }
    if (
      pickedHandle.name.toLowerCase() === "data" ||
      entries.some((e) => e.name.includes("com.crosspoint.reader"))
    ) {
      return await findAppDirIn(pickedHandle, pickedHandle.name);
    }
    return { handle: pickedHandle, label: pickedHandle.name };
  }

  async _resolveParentAndLeaf(vpath, createParents = false) {
    const norm = normalizeVPath(vpath);
    const parts = norm.split("/").filter(Boolean);
    if (parts.length === 0) return { parent: null, leaf: "", handle: this.rootHandle };
    const leaf = parts.pop();
    let curr = this.rootHandle;
    for (const seg of parts) {
      curr = await curr.getDirectoryHandle(seg, { create: createParents });
    }
    return { parent: curr, leaf };
  }

  async stat(vpath) {
    const norm = normalizeVPath(vpath);
    if (norm === "/") return { exists: true, isDir: true, size: 0 };
    try {
      const { parent, leaf } = await this._resolveParentAndLeaf(norm, false);
      try {
        const fh = await parent.getFileHandle(leaf);
        const file = await fh.getFile();
        return { exists: true, isDir: false, size: file.size };
      } catch {
        await parent.getDirectoryHandle(leaf);
        return { exists: true, isDir: true, size: 0 };
      }
    } catch {
      return { exists: false, isDir: false, size: 0 };
    }
  }

  async exists(vpath) {
    return (await this.stat(vpath)).exists;
  }

  async isDir(vpath) {
    const st = await this.stat(vpath);
    return st.exists && st.isDir;
  }

  async listDir(vpath) {
    const norm = normalizeVPath(vpath);
    try {
      let dirHandle = this.rootHandle;
      if (norm !== "/") {
        const { parent, leaf } = await this._resolveParentAndLeaf(norm, false);
        dirHandle = await parent.getDirectoryHandle(leaf);
      }
      const out = [];
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === "directory") {
          out.push({ name, isDir: true, size: 0 });
        } else {
          const f = await handle.getFile();
          out.push({ name, isDir: false, size: f.size });
        }
      }
      return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    } catch {
      return [];
    }
  }

  async readFile(vpath) {
    const { parent, leaf } = await this._resolveParentAndLeaf(vpath, false);
    const fh = await parent.getFileHandle(leaf);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(vpath, dataBytes) {
    const bytes = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
    const { parent, leaf } = await this._resolveParentAndLeaf(vpath, true);
    const fh = await parent.getFileHandle(leaf, { create: true });
    const writable = await fh.createWritable();
    await writable.write(bytes);
    await writable.close();
  }

  async mkdir(vpath) {
    const norm = normalizeVPath(vpath);
    if (norm === "/") return;
    const { parent, leaf } = await this._resolveParentAndLeaf(norm, true);
    await parent.getDirectoryHandle(leaf, { create: true });
  }

  async remove(vpath) {
    const norm = normalizeVPath(vpath);
    if (norm === "/") return false;
    try {
      const { parent, leaf } = await this._resolveParentAndLeaf(norm, false);
      await parent.removeEntry(leaf, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async rename(oldPath, newPath) {
    try {
      const data = await this.readFile(oldPath);
      await this.writeFile(newPath, data);
      await this.remove(oldPath);
      return true;
    } catch {
      return false;
    }
  }
}
