// Глобальные переменные
let currentPath = '';
let fileList = [];
let selectedItems = new Set(); // храним имена файлов/папок (относительно текущей директории)
let currentSort = { field: 'name', order: 'asc' };
const thumbnailCache = new Map(); // кэш для миниатюр (ключ = путь к файлу)

// DOM элементы
const fileListBody = document.getElementById('fileListBody');
const currentPathDisplay = document.getElementById('currentPathDisplay');
const upBtn = document.getElementById('upBtn');
const deleteBtn = document.getElementById('deleteBtn');
const moveBtn = document.getElementById('moveBtn');
const selectAllCheckbox = document.getElementById('selectAll');
const uploadBtn = document.getElementById('uploadBtn');
const mkdirBtn = document.getElementById('mkdirBtn');

// Модалки
const mkdirModal = document.getElementById('mkdirModal');
const deleteModal = document.getElementById('deleteModal');
const moveModal = document.getElementById('moveModal');
const previewModal = document.getElementById('previewModal');
const treeContainer = document.getElementById('treeContainer');

// Вспомогательные функции
function showToast(message, isError = true) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.backgroundColor = isError ? '#c92a2a' : '#2b8c4e';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

async function apiRequest(url, options = {}) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            let errorMsg = `Ошибка ${response.status}`;
            try {
                const data = await response.json();
                if (data.error) errorMsg = data.error;
            } catch(e) {}
            throw new Error(errorMsg);
        }
        if (options.method !== 'DELETE' && options.method !== 'POST' && !options.method) {
            return await response.json();
        }
        if (options.method === 'DELETE' || (options.method === 'POST' && response.headers.get('content-type')?.includes('application/json'))) {
            return await response.json();
        }
        return { status: 'ok' };
    } catch (err) {
        showToast(err.message);
        throw err;
    }
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleString();
}

// Определение типа файла по расширению
function getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'ogg', 'mov', 'avi'].includes(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    return 'other';
}

// Получить иконку для немедиа-файлов
function getIcon(item) {
    if (item.isDir) return '📁';
    const type = getFileType(item.name);
    if (type === 'image') return '🖼️';
    if (type === 'video') return '🎬';
    if (type === 'pdf') return '📑';
    return '📄';
}

// Генерация миниатюры для видео (первый кадр)
async function generateVideoThumbnail(filePath) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.crossOrigin = 'Anonymous';
        video.src = filePath;
        video.muted = true;
        video.currentTime = 0.1; // пытаемся захватить кадр на 0.1 секунде
        
        video.addEventListener('loadeddata', () => {
            // Некоторые браузеры требуют, чтобы video был в DOM для seek
            // Создаём временный контейнер
            const container = document.createElement('div');
            container.style.position = 'fixed';
            container.style.top = '-1000px';
            container.style.left = '-1000px';
            document.body.appendChild(container);
            container.appendChild(video);
            
            video.addEventListener('seeked', () => {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const dataURL = canvas.toDataURL('image/jpeg', 0.7);
                // Очистка
                video.pause();
                video.src = '';
                video.load();
                container.remove();
                resolve(dataURL);
            });
            
            video.addEventListener('error', (err) => {
                container.remove();
                reject(err);
            });
        });
        
        video.addEventListener('error', (err) => {
            reject(err);
        });
    });
}

// Получение миниатюры для элемента (кэшируется)
async function getThumbnail(item) {
    if (item.isDir) {
        return '📁'; // вернём иконку папки как текст
    }
    const filePath = currentPath ? `${currentPath}/${item.name}` : item.name;
    const fullUrl = `/api/file/${encodeURIComponent(filePath)}`;
    const cacheKey = fullUrl;
    
    if (thumbnailCache.has(cacheKey)) {
        return thumbnailCache.get(cacheKey);
    }
    
    const fileType = getFileType(item.name);
    if (fileType === 'image') {
        // Для изображений используем URL напрямую, но с уменьшением через стили
        thumbnailCache.set(cacheKey, fullUrl);
        return fullUrl;
    } else if (fileType === 'video') {
        try {
            const thumbDataUrl = await generateVideoThumbnail(fullUrl);
            thumbnailCache.set(cacheKey, thumbDataUrl);
            return thumbDataUrl;
        } catch (err) {
            console.warn(`Не удалось создать миниатюру для ${item.name}:`, err);
            const icon = getIcon(item);
            thumbnailCache.set(cacheKey, icon);
            return icon;
        }
    } else {
        const icon = getIcon(item);
        thumbnailCache.set(cacheKey, icon);
        return icon;
    }
}

// Загрузка списка файлов
async function loadFiles() {
    try {
        const params = new URLSearchParams({ path: currentPath });
        const data = await apiRequest(`/api/list?${params.toString()}`);
        fileList = data;
        renderFileList();
        updatePathDisplay();
    } catch(err) {
        console.error(err);
    }
}

function renderFileList() {
    // Сортировка на клиенте
    const sorted = [...fileList].sort((a,b) => {
        let aVal, bVal;
        if (currentSort.field === 'name') {
            aVal = a.name.toLowerCase();
            bVal = b.name.toLowerCase();
        } else if (currentSort.field === 'size') {
            aVal = a.isDir ? -1 : a.size;
            bVal = b.isDir ? -1 : b.size;
        } else if (currentSort.field === 'modTime') {
            aVal = new Date(a.modTime);
            bVal = new Date(b.modTime);
        } else if (currentSort.field === 'type') {
            aVal = a.isDir ? 'folder' : 'file';
            bVal = b.isDir ? 'folder' : 'file';
        }
        if (aVal < bVal) return currentSort.order === 'asc' ? -1 : 1;
        if (aVal > bVal) return currentSort.order === 'asc' ? 1 : -1;
        return 0;
    });
    
    fileListBody.innerHTML = '';
    
    for (const item of sorted) {
        const row = fileListBody.insertRow();
        
        // Чекбокс
        const cbCell = row.insertCell(0);
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'select-item';
        cb.dataset.name = item.name;
        cb.checked = selectedItems.has(item.name);
        cb.addEventListener('change', (e) => {
            if (cb.checked) selectedItems.add(item.name);
            else selectedItems.delete(item.name);
            updateSelectionButtons();
            updateSelectAll();
        });
        cbCell.appendChild(cb);
        
        // Колонка превью
        const previewCell = row.insertCell(1);
        previewCell.className = 'thumbnail';
        const placeholder = document.createElement('div');
        placeholder.style.width = '60px';
        placeholder.style.height = '60px';
        placeholder.style.display = 'flex';
        placeholder.style.alignItems = 'center';
        placeholder.style.justifyContent = 'center';
        placeholder.style.fontSize = '2rem';
        placeholder.innerText = '⏳'; // загрузка
        previewCell.appendChild(placeholder);
        
        // Асинхронно получаем миниатюру
        getThumbnail(item).then(result => {
            if (result.startsWith('data:image') || result.startsWith('/api/file')) {
                const img = document.createElement('img');
                img.src = result;
                img.style.width = '60px';
                img.style.height = '60px';
                img.style.objectFit = 'cover';
                img.style.borderRadius = '8px';
                previewCell.innerHTML = '';
                previewCell.appendChild(img);
            } else {
                // иконка-эмодзи
                previewCell.innerHTML = '';
                previewCell.style.fontSize = '1.5rem';
                previewCell.innerText = result;
            }
        }).catch(() => {
            previewCell.innerHTML = '';
            previewCell.style.fontSize = '1.5rem';
            previewCell.innerText = getIcon(item);
        });
        
        // Имя файла/папки
        const nameCell = row.insertCell(2);
        nameCell.className = 'file-name';
        nameCell.innerHTML = `${getIcon(item)} ${item.name}`;
        nameCell.addEventListener('click', (e) => {
            if (e.target.type !== 'checkbox') {
                if (item.isDir) {
                    currentPath = currentPath ? `${currentPath}/${item.name}` : item.name;
                    selectedItems.clear();
                    loadFiles();
                } else {
                    previewFile(item);
                }
            }
        });
        
        // Тип
        const typeCell = row.insertCell(3);
        typeCell.innerText = item.isDir ? 'Папка' : 'Файл';
        
        // Размер
        const sizeCell = row.insertCell(4);
        sizeCell.innerText = item.isDir ? '-' : formatSize(item.size);
        
        // Дата
        const dateCell = row.insertCell(5);
        dateCell.innerText = formatDate(item.modTime);
    }
    updateSelectAll();
}

function updatePathDisplay() {
    currentPathDisplay.innerText = '/' + (currentPath || '');
}

function updateSelectionButtons() {
    const hasSelected = selectedItems.size > 0;
    deleteBtn.disabled = !hasSelected;
    moveBtn.disabled = !hasSelected;
}

function updateSelectAll() {
    const checkboxes = document.querySelectorAll('.select-item');
    const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);
    selectAllCheckbox.checked = allChecked;
}

// События сортировки
document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (currentSort.field === field) {
            currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort.field = field;
            currentSort.order = 'asc';
        }
        renderFileList();
    });
});

selectAllCheckbox.addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.select-item');
    checkboxes.forEach(cb => {
        cb.checked = e.target.checked;
        const name = cb.dataset.name;
        if (e.target.checked) selectedItems.add(name);
        else selectedItems.delete(name);
    });
    updateSelectionButtons();
});

upBtn.addEventListener('click', () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    currentPath = parts.join('/');
    selectedItems.clear();
    loadFiles();
});

// Загрузка файлов (один или несколько, отдельными запросами)
uploadBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            await uploadFile(file);
        }
        loadFiles();
    };
    input.click();
});

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    if (currentPath) formData.append('path', currentPath);
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload', true);
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                const percent = (event.loaded / event.total) * 100;
                showToast(`Загрузка ${file.name}: ${Math.round(percent)}%`, false);
            }
        };
        await new Promise((resolve, reject) => {
            xhr.onload = () => {
                if (xhr.status === 200) resolve();
                else reject(new Error(`Ошибка загрузки ${file.name}`));
            };
            xhr.onerror = () => reject(new Error(`Ошибка сети при загрузке ${file.name}`));
            xhr.send(formData);
        });
        showToast(`${file.name} загружен`, false);
    } catch(err) {
        showToast(err.message);
    }
}

// Drag & Drop
const dropZone = document.body;
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});
function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}
dropZone.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
        await uploadFile(file);
    }
    loadFiles();
});

// Создание папки
mkdirBtn.addEventListener('click', () => {
    mkdirModal.style.display = 'flex';
});
document.querySelector('#mkdirModal .close').addEventListener('click', () => {
    mkdirModal.style.display = 'none';
});
document.getElementById('confirmMkdir').addEventListener('click', async () => {
    const name = document.getElementById('newFolderName').value.trim();
    if (!name) {
        showToast('Введите имя папки');
        return;
    }
    try {
        await apiRequest('/api/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath, name: name })
        });
        mkdirModal.style.display = 'none';
        document.getElementById('newFolderName').value = '';
        loadFiles();
    } catch(err) {}
});

// Удаление
deleteBtn.addEventListener('click', () => {
    if (selectedItems.size === 0) return;
    deleteModal.style.display = 'flex';
});
document.querySelector('#deleteModal .close').addEventListener('click', () => {
    deleteModal.style.display = 'none';
});
document.getElementById('cancelDelete').addEventListener('click', () => {
    deleteModal.style.display = 'none';
});
document.getElementById('confirmDelete').addEventListener('click', async () => {
    const pathsToDelete = Array.from(selectedItems).map(name => {
        return currentPath ? `${currentPath}/${name}` : name;
    });
    try {
        await apiRequest('/api/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: pathsToDelete })
        });
        deleteModal.style.display = 'none';
        selectedItems.clear();
        loadFiles();
    } catch(err) {}
});

// Перемещение
moveBtn.addEventListener('click', () => {
    if (selectedItems.size === 0) return;
    moveModal.style.display = 'flex';
    document.getElementById('destPathInput').value = '';
    treeContainer.style.display = 'none';
});
document.querySelector('#moveModal .close').addEventListener('click', () => {
    moveModal.style.display = 'none';
});
document.getElementById('selectPathFromTree').addEventListener('click', async () => {
    try {
        const tree = await apiRequest('/api/tree');
        treeContainer.style.display = 'block';
        treeContainer.innerHTML = '';
        function renderTree(nodes, prefix = '') {
            for (const node of nodes) {
                const div = document.createElement('div');
                div.className = 'tree-node';
                div.innerText = `${prefix}📁 ${node.name}`;
                div.addEventListener('click', () => {
                    document.getElementById('destPathInput').value = node.path;
                    treeContainer.style.display = 'none';
                });
                treeContainer.appendChild(div);
                if (node.children) renderTree(node.children, prefix + '  ');
            }
        }
        renderTree(tree);
    } catch(err) {}
});
document.getElementById('confirmMove').addEventListener('click', async () => {
    const dest = document.getElementById('destPathInput').value.trim();
    if (!dest) {
        showToast('Введите путь назначения');
        return;
    }
    const sources = Array.from(selectedItems).map(name => currentPath ? `${currentPath}/${name}` : name);
    try {
        await apiRequest('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: sources, destination: dest })
        });
        moveModal.style.display = 'none';
        selectedItems.clear();
        loadFiles();
    } catch(err) {}
});

// Предпросмотр
async function previewFile(item) {
    const filePath = currentPath ? `${currentPath}/${item.name}` : item.name;
    const url = `/api/file/${encodeURIComponent(filePath)}`;
    const ext = item.name.split('.').pop().toLowerCase();
    const container = document.getElementById('previewContainer');
    container.innerHTML = '';
    if (['jpg','jpeg','png','gif','webp','svg'].includes(ext)) {
        const img = document.createElement('img');
        img.src = url;
        img.style.maxWidth = '100%';
        img.style.maxHeight = '80vh';
        container.appendChild(img);
    } else if (['mp4','webm','ogg'].includes(ext)) {
        const video = document.createElement('video');
        video.controls = true;
        video.src = url;
        video.style.maxWidth = '100%';
        video.style.maxHeight = '80vh';
        container.appendChild(video);
    } else if (ext === 'pdf') {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.style.width = '100%';
        iframe.style.height = '80vh';
        container.appendChild(iframe);
    } else {
        window.location.href = `/api/download?path=${encodeURIComponent(filePath)}`;
        return;
    }
    previewModal.style.display = 'flex';
}
document.querySelector('#previewModal .close').addEventListener('click', () => {
    previewModal.style.display = 'none';
});

// Инициализация
loadFiles();
