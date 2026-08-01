const express = require('express');
const multer = require('multer');
const { UnityBundle, CLASS_NAMES, modifyMaterialColor } = require('./unity_parser');
const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

function getObjectName(data) {
    if (data.length < 4) return 'Unknown';
    try {
        const len = data.readUInt32LE(0);
        if (len > 0 && len < 256 && data.length >= 4 + len) {
            return data.toString('utf8', 4, 4 + len);
        }
    } catch (e) {}
    return 'Unknown';
}

router.post('/ListPathIds', upload.single('assetFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const bundle = new UnityBundle();
        bundle.load(req.file.buffer);
        if (!bundle.serializedFile) return res.status(400).json({ error: 'Invalid Unity bundle' });

        const list = bundle.serializedFile.objects.map(obj => ({
            pathId: obj.pathId,
            name: getObjectName(obj.data),
            typeName: CLASS_NAMES[obj.classId] || `Unknown(${obj.classId})`,
            size: obj.byteSize
        }));
        res.json(list);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to parse bundle: ' + err.message });
    }
});

router.post('/ExportDump', upload.single('assetFile'), (req, res) => {
    const { pathId } = req.body;
    if (!req.file || !pathId) return res.status(400).json({ error: 'Missing file or pathId' });
    try {
        const bundle = new UnityBundle();
        bundle.load(req.file.buffer);
        const obj = bundle.serializedFile.objects.find(o => o.pathId === pathId);
        if (!obj) return res.status(404).json({ error: 'Object not found' });

        // For Shaders, try to extract some text if possible, otherwise hex dump
        let dumpText = '';
        if (obj.classId === 48) { // Shader
            const name = getObjectName(obj.data);
            dumpText = `Shader Name: ${name}\n\nRaw Data Hex:\n${obj.data.toString('hex').slice(0, 2000)}...`;
        } else {
            dumpText = obj.data.toString('hex');
        }
        res.send(dumpText);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/CompareFiles', upload.fields([{ name: 'originalFile' }, { name: 'modifiedFile' }]), (req, res) => {
    if (!req.files || !req.files.originalFile || !req.files.modifiedFile) {
        return res.status(400).json({ error: 'Missing files' });
    }
    try {
        const bundle1 = new UnityBundle();
        bundle1.load(req.files.originalFile[0].buffer);
        const bundle2 = new UnityBundle();
        bundle2.load(req.files.modifiedFile[0].buffer);

        const diffs = [];
        bundle2.serializedFile.objects.forEach(obj2 => {
            const obj1 = bundle1.serializedFile.objects.find(o => o.pathId === obj2.pathId);
            if (!obj1 || !obj1.data.equals(obj2.data)) {
                diffs.push({
                    pathId: obj2.pathId,
                    typeName: CLASS_NAMES[obj2.classId] || `Unknown(${obj2.classId})`,
                    dumpText: obj2.data.toString('hex').slice(0, 1000)
                });
            }
        });
        res.json(diffs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/ImportDump', upload.fields([{ name: 'assetFile' }, { name: 'dumpFile' }]), (req, res) => {
    const { pathId } = req.body;
    if (!req.files || !req.files.assetFile || !req.files.dumpFile || !pathId) {
        return res.status(400).json({ error: 'Missing files or pathId' });
    }
    try {
        const bundle = new UnityBundle();
        bundle.load(req.files.assetFile[0].buffer);
        const obj = bundle.serializedFile.objects.find(o => o.pathId === pathId);
        if (!obj) return res.status(404).json({ error: 'Object not found' });

        // Assume dumpFile is raw bytes or hex string
        let newData = req.files.dumpFile[0].buffer;
        // Check if it's hex string
        const text = newData.toString('utf8').trim();
        if (/^[0-9a-fA-F]+$/.test(text)) {
            newData = Buffer.from(text, 'hex');
        }

        obj.data = newData;
        const output = bundle.save();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename=modified.assets');
        res.send(output);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/HoloArmaColorProcess', upload.single('assetFile'), (req, res) => {
    const { mode, oloColorHex, borderColorHex, wallColorHex } = req.body;
    if (!req.file || !oloColorHex) return res.status(400).json({ error: 'Missing file or color' });
    try {
        const bundle = new UnityBundle();
        bundle.load(req.file.buffer);

        bundle.serializedFile.objects.forEach(obj => {
            if (obj.classId === 21) { // Material
                let data = obj.data;
                data = modifyMaterialColor(data, '_Color', oloColorHex);
                data = modifyMaterialColor(data, '_EmissionColor', oloColorHex);
                data = modifyMaterialColor(data, '_TintColor', oloColorHex);
                
                if (borderColorHex) {
                    data = modifyMaterialColor(data, '_BorderColor', borderColorHex);
                    data = modifyMaterialColor(data, '_OutlineColor', borderColorHex);
                }
                if (wallColorHex) {
                    data = modifyMaterialColor(data, '_WallColor', wallColorHex);
                }
                obj.data = data;
            }
        });

        const output = bundle.save();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename=holo_modified.assets');
        res.send(output);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
