const lz4 = require('lz4js');

class UnityBundle {
    constructor() {
        this.signature = '';
        this.version = 0;
        this.unityVersion = '';
        this.generatorVersion = '';
        this.fileSize = 0n;
        this.ciCompressedSize = 0;
        this.ciUncompressedSize = 0;
        this.flags = 0;
        this.nodes = [];
        this.blocks = [];
        this.fullData = Buffer.alloc(0);
        this.serializedFile = null;
    }

    static readCString(buffer, offset) {
        let end = offset;
        while (end < buffer.length && buffer[end] !== 0) {
            end++;
        }
        return {
            str: buffer.toString('utf8', offset, end),
            nextOffset: end + 1
        };
    }

    load(buffer) {
        let offset = 0;
        const sig = UnityBundle.readCString(buffer, offset);
        this.signature = sig.str;
        offset = sig.nextOffset;

        this.version = buffer.readUInt32BE(offset);
        offset += 4;

        const uv = UnityBundle.readCString(buffer, offset);
        this.unityVersion = uv.str;
        offset = uv.nextOffset;

        const gv = UnityBundle.readCString(buffer, offset);
        this.generatorVersion = gv.str;
        offset = gv.nextOffset;

        this.fileSize = buffer.readBigUInt64BE(offset);
        offset += 8;

        this.ciCompressedSize = buffer.readUInt32BE(offset);
        offset += 4;

        this.ciUncompressedSize = buffer.readUInt32BE(offset);
        offset += 4;

        this.flags = buffer.readUInt32BE(offset);
        offset += 4;

        const compression = this.flags & 0x3F;
        const blockInfoNeedPadding = (this.flags & 0x200) !== 0;

        if (blockInfoNeedPadding) {
            offset = Math.ceil(offset / 16) * 16;
        }

        const blockInfoData = buffer.slice(offset, offset + this.ciCompressedSize);
        offset += this.ciCompressedSize;

        let decompressedInfo;
        if (compression === 2 || compression === 3) {
            decompressedInfo = Buffer.alloc(this.ciUncompressedSize);
            lz4.decompressBlock(blockInfoData, decompressedInfo, 0, blockInfoData.length, 0);
        } else {
            decompressedInfo = blockInfoData;
        }

        const dataStart = Math.ceil(offset / 16) * 16;

        // Parse block info
        let infoOffset = 16; // skip hash
        const blockCount = decompressedInfo.readUInt32BE(infoOffset);
        infoOffset += 4;

        this.blocks = [];
        for (let i = 0; i < blockCount; i++) {
            const uSize = decompressedInfo.readUInt32BE(infoOffset);
            const cSize = decompressedInfo.readUInt32BE(infoOffset + 4);
            const bFlags = decompressedInfo.readUInt16BE(infoOffset + 8);
            infoOffset += 10;
            this.blocks.push({ uSize, cSize, comp: bFlags & 0x3F });
        }

        const nodeCount = decompressedInfo.readUInt32BE(infoOffset);
        infoOffset += 4;

        this.nodes = [];
        for (let i = 0; i < nodeCount; i++) {
            const nodeOffset = Number(decompressedInfo.readBigUInt64BE(infoOffset));
            const nodeSize = Number(decompressedInfo.readBigUInt64BE(infoOffset + 8));
            const nFlags = decompressedInfo.readUInt32BE(infoOffset + 16);
            infoOffset += 20;
            const ns = UnityBundle.readCString(decompressedInfo, infoOffset);
            infoOffset = ns.nextOffset;
            this.nodes.push({ offset: nodeOffset, size: nodeSize, flags: nFlags, name: ns.str });
        }

        // Decompress data blocks
        let currentDataOffset = dataStart;
        const fullDataParts = [];
        for (const block of this.blocks) {
            const raw = buffer.slice(currentDataOffset, currentDataOffset + block.cSize);
            currentDataOffset += block.cSize;
            if (block.comp === 2 || block.comp === 3) {
                const decompressed = Buffer.alloc(block.uSize);
                lz4.decompressBlock(raw, decompressed, 0, raw.length, 0);
                fullDataParts.push(decompressed);
            } else {
                fullDataParts.push(raw);
            }
        }
        this.fullData = Buffer.concat(fullDataParts);

        if (this.nodes.length > 0) {
            const node = this.nodes[0];
            const nodeData = this.fullData.slice(node.offset, node.offset + node.size);
            this.serializedFile = new SerializedFile();
            this.serializedFile.load(nodeData);
        }
    }

    save() {
        if (this.serializedFile) {
            const nodeData = this.serializedFile.save();
            this.nodes[0].size = nodeData.length;
            this.fullData = nodeData; 
        }

        const uSize = this.fullData.length;
        const maxCSize = lz4.compressBound(uSize);
        const compressedData = Buffer.alloc(maxCSize);
        const cSize = lz4.compressBlock(this.fullData, compressedData, 0, uSize, 0);
        const finalCompressedData = compressedData.slice(0, cSize);

        this.blocks = [{ uSize, cSize, comp: 3 }];

        let infoSize = 16 + 4 + (this.blocks.length * 10) + 4;
        for (const node of this.nodes) {
            infoSize += 20 + Buffer.byteLength(node.name, 'utf8') + 1;
        }
        const infoBuffer = Buffer.alloc(infoSize);
        let infoOffset = 16;
        infoBuffer.writeUInt32BE(this.blocks.length, infoOffset);
        infoOffset += 4;
        for (const block of this.blocks) {
            infoBuffer.writeUInt32BE(block.uSize, infoOffset);
            infoBuffer.writeUInt32BE(block.cSize, infoOffset + 4);
            infoBuffer.writeUInt16BE(block.comp, infoOffset + 8);
            infoOffset += 10;
        }
        infoBuffer.writeUInt32BE(this.nodes.length, infoOffset);
        infoOffset += 4;
        for (const node of this.nodes) {
            infoBuffer.writeBigUInt64BE(BigInt(node.offset), infoOffset);
            infoBuffer.writeBigUInt64BE(BigInt(node.size), infoOffset + 8);
            infoBuffer.writeUInt32BE(node.flags, infoOffset + 16);
            infoOffset += 20;
            infoBuffer.write(node.name, infoOffset, 'utf8');
            infoOffset += Buffer.byteLength(node.name, 'utf8');
            infoBuffer[infoOffset++] = 0;
        }

        const compressedInfo = Buffer.alloc(lz4.compressBound(infoBuffer.length));
        const ciCSize = lz4.compressBlock(infoBuffer, compressedInfo, 0, infoBuffer.length, 0);
        const finalCompressedInfo = compressedInfo.slice(0, ciCSize);

        this.ciCompressedSize = ciCSize;
        this.ciUncompressedSize = infoBuffer.length;

        let headerSize = Buffer.byteLength(this.signature, 'utf8') + 1 + 4 +
            Buffer.byteLength(this.unityVersion, 'utf8') + 1 +
            Buffer.byteLength(this.generatorVersion, 'utf8') + 1 +
            8 + 4 + 4 + 4;
        
        const blockInfoOffset = Math.ceil(headerSize / 16) * 16;
        const dataOffset = Math.ceil((blockInfoOffset + ciCSize) / 16) * 16;
        const totalSize = dataOffset + cSize;

        const finalBuffer = Buffer.alloc(totalSize);
        let offset = 0;
        finalBuffer.write(this.signature, offset, 'utf8');
        offset += Buffer.byteLength(this.signature, 'utf8');
        finalBuffer[offset++] = 0;
        finalBuffer.writeUInt32BE(this.version, offset);
        offset += 4;
        finalBuffer.write(this.unityVersion, offset, 'utf8');
        offset += Buffer.byteLength(this.unityVersion, 'utf8');
        finalBuffer[offset++] = 0;
        finalBuffer.write(this.generatorVersion, offset, 'utf8');
        offset += Buffer.byteLength(this.generatorVersion, 'utf8');
        finalBuffer[offset++] = 0;
        finalBuffer.writeBigUInt64BE(BigInt(totalSize), offset);
        offset += 8;
        finalBuffer.writeUInt32BE(this.ciCompressedSize, offset);
        offset += 4;
        finalBuffer.writeUInt32BE(this.ciUncompressedSize, offset);
        offset += 4;
        finalBuffer.writeUInt32BE(this.flags, offset);
        
        finalCompressedInfo.copy(finalBuffer, blockInfoOffset);
        finalCompressedData.copy(finalBuffer, dataOffset);

        return finalBuffer;
    }
}

class SerializedFile {
    constructor() {
        this.header = {};
        this.unityVersion = '';
        this.platform = 0;
        this.hasTypeTree = false;
        this.types = [];
        this.objects = [];
        this.bigEndian = false;
        this.objectCountOffset = 0;
        this.buffer = null;
    }

    load(buffer) {
        this.buffer = buffer;
        let offset = 0;
        this.header.metadataSize = buffer.readUInt32BE(offset);
        this.header.fileSize = buffer.readUInt32BE(offset + 4);
        this.header.version = buffer.readUInt32BE(offset + 8);
        this.header.dataOffset = buffer.readUInt32BE(offset + 12);
        offset += 16;

        if (this.header.version >= 22) {
            this.bigEndian = buffer[offset] !== 0;
            offset += 4;
            this.header.metadataSize = buffer.readUInt32LE(offset);
            this.header.fileSizeLong = buffer.readBigUInt64LE(offset + 4);
            this.header.dataOffsetLong = buffer.readBigUInt64LE(offset + 12);
            offset += 28;
        } else {
            this.bigEndian = buffer[offset] !== 0;
            offset += 4;
            this.header.dataOffsetLong = BigInt(this.header.dataOffset);
        }

        const readI32 = () => {
            const val = this.bigEndian ? buffer.readInt32BE(offset) : buffer.readInt32LE(offset);
            offset += 4;
            return val;
        };
        const readU32 = () => {
            const val = this.bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
            offset += 4;
            return val;
        };
        const readI64 = () => {
            const val = this.bigEndian ? buffer.readBigInt64BE(offset) : buffer.readBigInt64LE(offset);
            offset += 8;
            return val;
        };
        const readU64 = () => {
            const val = this.bigEndian ? buffer.readBigUInt64BE(offset) : buffer.readBigUInt64LE(offset);
            offset += 8;
            return val;
        };

        const uv = UnityBundle.readCString(buffer, offset);
        this.unityVersion = uv.str;
        offset = uv.nextOffset;

        this.platform = readU32();
        this.hasTypeTree = buffer[offset++] !== 0;

        const typeCount = readU32();
        this.types = [];
        for (let i = 0; i < typeCount; i++) {
            const classId = readI32();
            const isStripped = buffer[offset++] !== 0;
            const scriptTypeIndex = this.bigEndian ? buffer.readInt16BE(offset) : buffer.readInt16LE(offset);
            offset += 2;
            if ((this.header.version >= 17 && classId === 114) || (this.header.version < 17 && classId < 0)) offset += 16;
            offset += 16;
            if (this.hasTypeTree) {
                const treeNodeCount = readU32();
                const stringBufSize = readU32();
                const nodeSize = this.header.version >= 19 ? 32 : 24;
                offset += treeNodeCount * nodeSize;
                offset += stringBufSize;
                if (this.header.version >= 21) {
                    const refTypeCount = readU32();
                    offset += refTypeCount * 48;
                }
            }
            this.types.push({ classId });
        }

        this.objectCountOffset = offset;
        const objectCount = readU32();
        this.objects = [];
        for (let i = 0; i < objectCount; i++) {
            offset = Math.ceil(offset / 4) * 4;
            const pathId = this.header.version >= 17 ? readI64() : BigInt(readI32());
            const byteStart = this.header.version >= 22 ? readU64() : BigInt(readU32());
            const byteSize = readU32();
            const typeId = readU32();
            
            const realByteStart = Number(this.header.dataOffsetLong + byteStart);
            const objectData = buffer.slice(realByteStart, realByteStart + byteSize);

            this.objects.push({
                pathId: pathId.toString(),
                byteStart,
                byteSize,
                typeId,
                classId: this.types[typeId]?.classId,
                data: objectData
            });
        }
    }

    save() {
        let currentOffset = 0n;
        const objectDataParts = [];
        for (const obj of this.objects) {
            obj.byteStart = currentOffset;
            objectDataParts.push(obj.data);
            currentOffset += BigInt(obj.data.length);
            obj.byteSize = obj.data.length;
        }
        const allObjectData = Buffer.concat(objectDataParts);

        const headerAndTypes = this.buffer.slice(0, this.objectCountOffset);
        const newObjectInfo = Buffer.alloc(this.objects.length * 32 + 4);
        let oiOffset = 0;
        
        const writeU32 = (val) => {
            if (this.bigEndian) newObjectInfo.writeUInt32BE(val, oiOffset);
            else newObjectInfo.writeUInt32LE(val, oiOffset);
            oiOffset += 4;
        };
        const writeI64 = (val) => {
            if (this.bigEndian) newObjectInfo.writeBigInt64BE(BigInt(val), oiOffset);
            else newObjectInfo.writeBigInt64LE(BigInt(val), oiOffset);
            oiOffset += 8;
        };
        const writeU64 = (val) => {
            if (this.bigEndian) newObjectInfo.writeBigUInt64BE(BigInt(val), oiOffset);
            else newObjectInfo.writeBigUInt64LE(BigInt(val), oiOffset);
            oiOffset += 8;
        };

        if (this.bigEndian) newObjectInfo.writeUInt32BE(this.objects.length, oiOffset);
        else newObjectInfo.writeUInt32LE(this.objects.length, oiOffset);
        oiOffset += 4;

        for (const obj of this.objects) {
            while (oiOffset % 4 !== 0) oiOffset++;
            if (this.header.version >= 17) writeI64(obj.pathId);
            else writeU32(parseInt(obj.pathId));
            
            if (this.header.version >= 22) writeU64(obj.byteStart);
            else writeU32(Number(obj.byteStart));
            
            writeU32(obj.byteSize);
            writeU32(obj.typeId);
        }
        
        const metadata = Buffer.concat([headerAndTypes, newObjectInfo.slice(0, oiOffset)]);
        const dataOffset = Math.ceil(metadata.length / 16) * 16;
        const finalBuffer = Buffer.alloc(dataOffset + allObjectData.length);
        metadata.copy(finalBuffer);
        allObjectData.copy(finalBuffer, dataOffset);
        
        finalBuffer.writeUInt32BE(metadata.length, 0);
        finalBuffer.writeUInt32BE(finalBuffer.length, 4);
        finalBuffer.writeUInt32BE(this.header.version, 8);
        finalBuffer.writeUInt32BE(dataOffset, 12);
        
        if (this.header.version >= 22) {
            finalBuffer.writeUInt32LE(metadata.length, 20);
            finalBuffer.writeBigUInt64LE(BigInt(finalBuffer.length), 24);
            finalBuffer.writeBigUInt64LE(BigInt(dataOffset), 32);
        }

        return finalBuffer;
    }
}

function modifyMaterialColor(data, propertyName, colorHex) {
    const r = parseInt(colorHex.slice(1, 3), 16) / 255;
    const g = parseInt(colorHex.slice(3, 5), 16) / 255;
    const b = parseInt(colorHex.slice(5, 7), 16) / 255;
    const a = colorHex.length > 7 ? parseInt(colorHex.slice(7, 9), 16) / 255 : 1.0;

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(propertyName.length, 0);
    const searchBuf = Buffer.concat([lenBuf, Buffer.from(propertyName, 'utf8')]);
    
    let index = data.indexOf(searchBuf);
    if (index === -1) return data;

    const valueIndex = Math.ceil((index + searchBuf.length) / 4) * 4;
    const newData = Buffer.from(data);
    newData.writeFloatLE(r, valueIndex);
    newData.writeFloatLE(g, valueIndex + 4);
    newData.writeFloatLE(b, valueIndex + 8);
    newData.writeFloatLE(a, valueIndex + 12);
    return newData;
}

const CLASS_NAMES = {
    1: 'GameObject', 4: 'Transform', 21: 'Material', 28: 'Texture2D', 43: 'Mesh', 48: 'Shader', 49: 'TextAsset', 114: 'MonoBehaviour', 142: 'AssetBundle'
};

module.exports = { UnityBundle, SerializedFile, CLASS_NAMES, modifyMaterialColor };
