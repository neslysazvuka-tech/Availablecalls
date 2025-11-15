// Конфигурация Supabase с вашими данными
const SUPABASE_URL = 'https://yltjyxogyjcximgvjdfr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsdGp5eG9neWpjeGltZ3ZqZGZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMxNzkwMTIsImV4cCI6MjA3ODc1NTAxMn0.BHahBG8MQqQToUBnT0VyWfPqjr-k4RYwls4xoy_B_k4';

// Инициализация Supabase
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Элементы DOM
const loginScreen = document.getElementById('login-screen');
const waitingScreen = document.getElementById('waiting-screen');
const callScreen = document.getElementById('call-screen');
const roomForm = document.getElementById('room-form');
const roomNumberInput = document.getElementById('room-number');
const currentRoomSpan = document.getElementById('current-room');
const callRoomSpan = document.getElementById('call-room');
const errorMessage = document.getElementById('error-message');
const cancelWaitingBtn = document.getElementById('cancel-waiting');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const muteAudioBtn = document.getElementById('mute-audio');
const muteVideoBtn = document.getElementById('mute-video');
const endCallBtn = document.getElementById('end-call');

// Переменные состояния
let currentRoom = null;
let localStream = null;
let peerConnection = null;
let isCaller = false;
let roomTimeout = null;
let signalingChannels = [];
let activityCheckInterval = null;
let lastActivityTime = Date.now();
let userId = generateUserId();
let isUserActive = true;
let callStartTime = null;
let callTimerInterval = null;

// Генерация уникального ID пользователя
function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

// Улучшенная конфигурация STUN/TURN серверов
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { 
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        { 
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    // Обработчик отправки формы
    roomForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const roomNumber = roomNumberInput.value.trim();
        
        if (!roomNumber || !/^\d{1,14}$/.test(roomNumber)) {
            showError('Пожалуйста, введите корректный номер (1-14 цифр)');
            return;
        }
        
        await joinRoom(roomNumber);
    });

    // Обработчик отмены ожидания
    cancelWaitingBtn.addEventListener('click', () => {
        leaveRoom();
        showScreen(loginScreen);
    });

    // Обработчики кнопок управления звонком
    muteAudioBtn.addEventListener('click', toggleAudio);
    muteVideoBtn.addEventListener('click', toggleVideo);
    endCallBtn.addEventListener('click', endCall);

    // Обработчик ввода номера комнаты
    roomNumberInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 14);
    });

    // Отслеживание активности пользователя
    setupActivityTracking();
    
    // Периодическая очистка неактивных комнат
    startRoomCleanupInterval();
}

// Настройка отслеживания активности
function setupActivityTracking() {
    // События активности пользователя
    const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    activityEvents.forEach(event => {
        document.addEventListener(event, updateActivity, true);
    });

    // Проверка активности каждые 30 секунд
    activityCheckInterval = setInterval(checkActivity, 30000);
}

// Обновление времени активности
function updateActivity() {
    lastActivityTime = Date.now();
    isUserActive = true;
    
    // Обновляем активность в комнате если мы в ней
    if (currentRoom) {
        updateUserActivity();
    }
}

// Проверка активности
function checkActivity() {
    const inactiveTime = Date.now() - lastActivityTime;
    const inactiveThreshold = 5 * 60 * 1000; // 5 минут
    
    if (inactiveTime > inactiveThreshold && isUserActive) {
        isUserActive = false;
        console.log('Пользователь неактивен более 5 минут');
        
        // Если мы в комнате, выходим из нее
        if (currentRoom) {
            showError('Вы были неактивны более 5 минут. Комната будет удалена.');
            endCall();
        }
    }
}

// Запуск периодической очистки комнат
function startRoomCleanupInterval() {
    setInterval(async () => {
        await cleanupInactiveRooms();
    }, 2 * 60 * 1000); // Проверка каждые 2 минуты
}

// Функция присоединения к комнате
async function joinRoom(roomNumber) {
    try {
        currentRoom = roomNumber;
        currentRoomSpan.textContent = roomNumber;
        
        // Сначала проверяем и очищаем старые комнаты
        await cleanupInactiveRooms();
        
        // Проверяем существование комнаты
        const { data: existingRoom, error } = await supabase
            .from('rooms')
            .select('*')
            .eq('room_number', roomNumber)
            .single();
        
        if (error && error.code !== 'PGRST116') {
            throw error;
        }
        
        if (existingRoom) {
            // Проверяем, не устарела ли комната
            if (isRoomExpired(existingRoom)) {
                // Удаляем устаревшую комнату и создаем новую
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_number', roomNumber);
                
                // Также очищаем signaling данные
                await supabase
                    .from('signaling')
                    .delete()
                    .eq('room_number', roomNumber);
                
                isCaller = true;
                await setupMedia();
                await createNewRoom();
            } else {
                // Комната существует - присоединяемся как второй участник
                if (existingRoom.participants >= 2) {
                    showError('Комната уже заполнена. Максимум 2 участника.');
                    return;
                }
                isCaller = false;
                await setupMedia();
                await joinExistingRoom(existingRoom);
            }
        } else {
            // Комната не существует - создаем новую
            isCaller = true;
            await setupMedia();
            await createNewRoom();
        }
        
        showScreen(waitingScreen);
        resetRoomTimeout();
        
    } catch (error) {
        console.error('Ошибка при присоединении к комнате:', error);
        showError('Не удалось присоединиться к комнате: ' + error.message);
        cleanup();
    }
}

// Проверка устаревания комнаты
function isRoomExpired(room) {
    const lastActivity = new Date(room.last_activity);
    const now = new Date();
    const diffMinutes = (now - lastActivity) / (1000 * 60);
    return diffMinutes > 10; // Комната устарела через 10 минут
}

// Очистка неактивных комнат
async function cleanupInactiveRooms() {
    try {
        const { data: allRooms, error } = await supabase
            .from('rooms')
            .select('*');
        
        if (error) throw error;
        
        const now = new Date();
        const cleanupPromises = allRooms.map(async (room) => {
            const lastActivity = new Date(room.last_activity);
            const diffMinutes = (now - lastActivity) / (1000 * 60);
            
            if (diffMinutes > 10 || room.participants === 0) {
                console.log('Удаляем неактивную комнату:', room.room_number);
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_number', room.room_number);
                
                // Также очищаем signaling данные
                await supabase
                    .from('signaling')
                    .delete()
                    .eq('room_number', room.room_number);
            }
        });
        
        await Promise.all(cleanupPromises);
    } catch (error) {
        console.error('Ошибка при очистке комнат:', error);
    }
}

// Функция создания новой комнаты
async function createNewRoom() {
    const { data, error } = await supabase
        .from('rooms')
        .insert([
            { 
                room_number: currentRoom,
                created_at: new Date().toISOString(),
                participants: 1,
                last_activity: new Date().toISOString(),
                user_ids: [userId]
            }
        ])
        .select()
        .single();
    
    if (error) throw error;
    
    // Подписываемся на изменения комнаты
    subscribeToRoomChanges();
    
    // Запускаем мониторинг активности комнаты
    startRoomActivityMonitoring();
}

// Функция присоединения к существующей комнате
async function joinExistingRoom(room) {
    // Обновляем количество участников и добавляем пользователя
    const updatedUserIds = [...(room.user_ids || []), userId];
    
    const { error } = await supabase
        .from('rooms')
        .update({ 
            participants: 2,
            last_activity: new Date().toISOString(),
            user_ids: updatedUserIds
        })
        .eq('room_number', currentRoom);
    
    if (error) throw error;
    
    // Подписываемся на изменения комнаты
    subscribeToRoomChanges();
    
    // Запускаем мониторинг активности комнаты
    startRoomActivityMonitoring();
}

// Мониторинг активности комнаты
function startRoomActivityMonitoring() {
    // Обновляем активность каждую минуту
    const activityInterval = setInterval(async () => {
        if (currentRoom && isUserActive) {
            await updateUserActivity();
        } else {
            clearInterval(activityInterval);
        }
    }, 60000);
}

// Обновление активности пользователя
async function updateUserActivity() {
    if (!currentRoom) return;
    
    try {
        const { error } = await supabase
            .from('rooms')
            .update({ 
                last_activity: new Date().toISOString()
            })
            .eq('room_number', currentRoom);
        
        if (error) console.error('Ошибка обновления активности:', error);
    } catch (error) {
        console.error('Ошибка обновления активности:', error);
    }
}

// Функция подписки на изменения комнаты
function subscribeToRoomChanges() {
    const roomChannel = supabase
        .channel(`room-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'rooms',
                filter: `room_number=eq.${currentRoom}`
            },
            async (payload) => {
                console.log('Room update:', payload);
                
                if (payload.eventType === 'UPDATE') {
                    if (payload.new.participants === 2 && isCaller) {
                        // Второй участник присоединился - начинаем звонок
                        await startCall();
                    }
                    
                    // Проверяем, не удалена ли комната системой очистки
                    if (payload.new.participants === 0) {
                        showError('Комната была автоматически удалена из-за неактивности');
                        endCall();
                    }
                } else if (payload.eventType === 'DELETE') {
                    // Комната удалена - завершаем звонок
                    if (callScreen.classList.contains('active')) {
                        showError('Комната была удалена');
                        endCall();
                    } else {
                        showError('Комната была удалена');
                        showScreen(loginScreen);
                    }
                }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to room changes');
            }
        });
    
    signalingChannels.push(roomChannel);
}

// Функция настройки медиа (камера и микрофон)
async function setupMedia() {
    try {
        // Запрашиваем разрешение только на аудио сначала
        const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000,
                sampleSize: 16
            },
            video: false
        });

        // Затем запрашиваем видео
        const videoStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            }
        });

        // Объединяем потоки
        localStream = new MediaStream([
            ...audioStream.getAudioTracks(),
            ...videoStream.getVideoTracks()
        ]);

        localVideo.srcObject = localStream;
        
        console.log('Аудио треки:', localStream.getAudioTracks());
        console.log('Видео треки:', localStream.getVideoTracks());
        
    } catch (error) {
        console.error('Ошибка доступа к медиаустройствам:', error);
        
        // Пробуем получить только аудио
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false
            });
            localVideo.srcObject = localStream;
            showError('Видео недоступно, но аудио работает');
        } catch (audioError) {
            showError('Не удалось получить доступ к камере и микрофону. Пожалуйста, разрешите доступ и обновите страницу.');
            throw error;
        }
    }
}

// Функция начала звонка
async function startCall() {
    showScreen(callScreen);
    callRoomSpan.textContent = currentRoom;
    
    // Запускаем таймер звонка
    startCallTimer();
    
    try {
        // Создаем Peer Connection с улучшенной конфигурацией
        peerConnection = new RTCPeerConnection(configuration);
        
        // Критически важные обработчики для аудио
        peerConnection.onnegotiationneeded = async () => {
            console.log('Требуется переnegotiation');
        };

        // Добавляем локальный поток с проверкой треков
        localStream.getTracks().forEach(track => {
            console.log('Добавляем трек:', track.kind, track.id, track.enabled);
            peerConnection.addTrack(track, localStream);
        });

        // Обработчик получения удаленного потока
        peerConnection.ontrack = (event) => {
            console.log('Получен удаленный поток:', event.streams);
            if (event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
                
                // Принудительно включаем звук для удаленного видео
                remoteVideo.volume = 1.0;
                remoteVideo.muted = false;
                
                console.log('Удаленные треки:', event.streams[0].getTracks());
            }
        };
        
        // Обработчик ICE кандидатов
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Новый ICE кандидат');
                saveIceCandidate(event.candidate);
            } else {
                console.log('Все ICE кандидаты собраны');
            }
        };
        
        // Обработчик изменения состояния соединения
        peerConnection.onconnectionstatechange = (event) => {
            console.log('Состояние соединения:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                console.log('Соединение установлено!');
                showNotification('Соединение установлено!', 'success');
            } else if (peerConnection.connectionState === 'disconnected' || 
                      peerConnection.connectionState === 'failed') {
                console.log('Соединение прервано');
                showNotification('Соединение прервано', 'error');
                endCall();
            }
        };

        if (isCaller) {
            // Создаем предложение с аудио и видео
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            console.log('Создан offer:', offer.type);
            await peerConnection.setLocalDescription(offer);
            
            // Сохраняем предложение в Supabase
            await saveOffer(offer);
            
            // Слушаем ответ
            listenForAnswer();
        } else {
            // Слушаем предложение
            listenForOffer();
        }
        
        // Слушаем ICE кандидаты
        listenForIceCandidates();
        
    } catch (error) {
        console.error('Ошибка при начале звонка:', error);
        showError('Ошибка при установке соединения: ' + error.message);
        endCall();
    }
}

// Запуск таймера звонка
function startCallTimer() {
    callStartTime = Date.now();
    updateCallTimer();
    
    callTimerInterval = setInterval(updateCallTimer, 1000);
}

// Обновление таймера звонка
function updateCallTimer() {
    if (!callStartTime) return;
    
    const elapsed = Date.now() - callStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    
    const timerElement = document.getElementById('call-timer') || createCallTimerElement();
    timerElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Создание элемента таймера
function createCallTimerElement() {
    const timerElement = document.createElement('div');
    timerElement.id = 'call-timer';
    timerElement.className = 'call-timer';
    timerElement.textContent = '00:00';
    
    const callContainer = document.querySelector('.call-container');
    const roomInfo = callContainer.querySelector('p');
    roomInfo.appendChild(timerElement);
    
    return timerElement;
}

// Функция сохранения предложения в Supabase
async function saveOffer(offer) {
    const { error } = await supabase
        .from('signaling')
        .insert([
            {
                room_number: currentRoom,
                type: 'offer',
                sdp: offer.sdp
            }
        ]);
    
    if (error) throw error;
}

// Функция сохранения ICE кандидата в Supabase
async function saveIceCandidate(candidate) {
    const { error } = await supabase
        .from('signaling')
        .insert([
            {
                room_number: currentRoom,
                type: 'ice-candidate',
                candidate: JSON.stringify(candidate)
            }
        ]);
    
    if (error) console.error('Ошибка сохранения ICE кандидата:', error);
}

// Функция прослушивания предложения
function listenForOffer() {
    const offerChannel = supabase
        .channel(`offer-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'signaling',
                filter: `room_number=eq.${currentRoom} AND type=eq.offer`
            },
            async (payload) => {
                console.log('Получено предложение');
                await handleOffer(payload.new);
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to offers');
            }
        });
    
    signalingChannels.push(offerChannel);
}

// Функция обработки предложения
async function handleOffer(offerData) {
    if (!isCaller && peerConnection) {
        try {
            console.log('Обрабатываем полученное предложение');
            
            await peerConnection.setRemoteDescription({
                type: 'offer',
                sdp: offerData.sdp
            });
            
            // Создаем ответ с обязательным аудио
            const answer = await peerConnection.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            await peerConnection.setLocalDescription(answer);
            
            // Сохраняем ответ в Supabase
            const { error } = await supabase
                .from('signaling')
                .insert([
                    {
                        room_number: currentRoom,
                        type: 'answer',
                        sdp: answer.sdp
                    }
                ]);
            
            if (error) throw error;
            
            console.log('Ответ отправлен');
            
        } catch (error) {
            console.error('Ошибка обработки предложения:', error);
            showError('Ошибка при соединении: ' + error.message);
        }
    }
}

// Функция прослушивания ответа
function listenForAnswer() {
    const answerChannel = supabase
        .channel(`answer-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'signaling',
                filter: `room_number=eq.${currentRoom} AND type=eq.answer`
            },
            async (payload) => {
                console.log('Получен ответ');
                if (peerConnection) {
                    try {
                        await peerConnection.setRemoteDescription({
                            type: 'answer',
                            sdp: payload.new.sdp
                        });
                        console.log('Удаленное описание установлено');
                    } catch (error) {
                        console.error('Ошибка установки remote description:', error);
                    }
                }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to answers');
            }
        });
    
    signalingChannels.push(answerChannel);
}

// Функция прослушивания ICE кандидатов
function listenForIceCandidates() {
    const iceChannel = supabase
        .channel(`ice-${currentRoom}`)
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'signaling',
                filter: `room_number=eq.${currentRoom} AND type=eq.ice-candidate`
            },
            async (payload) => {
                console.log('Получен ICE кандидат');
                if (peerConnection && peerConnection.remoteDescription) {
                    try {
                        const candidate = JSON.parse(payload.new.candidate);
                        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (error) {
                        console.error('Ошибка добавления ICE кандидата:', error);
                    }
                }
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to ICE candidates');
            }
        });
    
    signalingChannels.push(iceChannel);
}

// Функция переключения аудио
function toggleAudio() {
    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks.length > 0) {
            const audioTrack = audioTracks[0];
            audioTrack.enabled = !audioTrack.enabled;
            muteAudioBtn.classList.toggle('muted', !audioTrack.enabled);
            
            // Обновляем индикатор на видео
            const videoWrapper = localVideo.closest('.video-wrapper');
            if (videoWrapper) {
                videoWrapper.classList.toggle('audio-muted', !audioTrack.enabled);
            }
            
            console.log('Аудио ' + (audioTrack.enabled ? 'включено' : 'выключено'));
            showNotification(`Микрофон ${audioTrack.enabled ? 'включен' : 'выключен'}`, 'info');
        } else {
            console.log('Аудио треки не найдены');
        }
    }
}

// Функция переключения видео
function toggleVideo() {
    if (localStream) {
        const videoTracks = localStream.getVideoTracks();
        if (videoTracks.length > 0) {
            const videoTrack = videoTracks[0];
            videoTrack.enabled = !videoTrack.enabled;
            muteVideoBtn.classList.toggle('muted', !videoTrack.enabled);
            
            console.log('Видео ' + (videoTrack.enabled ? 'включено' : 'выключено'));
            showNotification(`Камера ${videoTrack.enabled ? 'включена' : 'выключена'}`, 'info');
        }
    }
}

// Функция завершения звонка
async function endCall() {
    console.log('Завершение звонка');
    
    // Останавливаем таймер звонка
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    callStartTime = null;
    
    // Останавливаем медиапотоки
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log('Остановлен трек:', track.kind);
        });
        localStream = null;
    }
    
    // Закрываем Peer Connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    // Выходим из комнаты
    await leaveRoom();
    
    // Показываем экран входа
    showScreen(loginScreen);
}

// Функция выхода из комнаты
async function leaveRoom() {
    if (currentRoom) {
        try {
            // Получаем текущее состояние комнаты
            const { data: room, error: fetchError } = await supabase
                .from('rooms')
                .select('*')
                .eq('room_number', currentRoom)
                .single();
            
            if (!fetchError && room) {
                // Убираем текущего пользователя из списка участников
                const updatedUserIds = (room.user_ids || []).filter(id => id !== userId);
                const updatedParticipants = Math.max(0, room.participants - 1);
                
                if (updatedParticipants === 0) {
                    // Если участников не осталось - удаляем комнату
                    await supabase
                        .from('rooms')
                        .delete()
                        .eq('room_number', currentRoom);
                } else {
                    // Обновляем комнату с новыми данными
                    await supabase
                        .from('rooms')
                        .update({ 
                            participants: updatedParticipants,
                            user_ids: updatedUserIds,
                            last_activity: new Date().toISOString()
                        })
                        .eq('room_number', currentRoom);
                }
            }
            
            // Очищаем signaling данные
            await supabase
                .from('signaling')
                .delete()
                .eq('room_number', currentRoom);
                
        } catch (error) {
            console.error('Ошибка при выходе из комнаты:', error);
        }
        
        // Отписываемся от каналов
        cleanupSignalingChannels();
        
        currentRoom = null;
    }
    
    // Очищаем таймаут комнаты
    if (roomTimeout) {
        clearTimeout(roomTimeout);
        roomTimeout = null;
    }
}

// Функция очистки signaling каналов
function cleanupSignalingChannels() {
    signalingChannels.forEach(channel => {
        supabase.removeChannel(channel);
    });
    signalingChannels = [];
}

// Функция сброса таймаута комнаты
function resetRoomTimeout() {
    if (roomTimeout) {
        clearTimeout(roomTimeout);
    }
    
    roomTimeout = setTimeout(async () => {
        if (currentRoom && !callScreen.classList.contains('active')) {
            // Удаляем комнату по таймауту
            try {
                await supabase
                    .from('rooms')
                    .delete()
                    .eq('room_number', currentRoom);
                
                // Также очищаем signaling данные
                await supabase
                    .from('signaling')
                    .delete()
                    .eq('room_number', currentRoom);
                
                showScreen(loginScreen);
                showError('Время ожидания истекло. Комната удалена.');
            } catch (error) {
                console.error('Ошибка удаления комнаты по таймауту:', error);
            }
        }
    }, 10 * 60 * 1000); // 10 минут
}

// Функция показа экрана
function showScreen(screen) {
    loginScreen.classList.remove('active');
    waitingScreen.classList.remove('active');
    callScreen.classList.remove('active');
    
    screen.classList.add('active');
}

// Функция показа ошибки
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove('hidden');
    
    setTimeout(() => {
        errorMessage.classList.add('hidden');
    }, 5000);
}

// Функция показа уведомления
function showNotification(message, type = 'info') {
    // Создаем элемент уведомления
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    // Добавляем в тело документа
    document.body.appendChild(notification);
    
    // Показываем с анимацией
    setTimeout(() => notification.classList.add('show'), 100);
    
    // Автоматически скрываем через 3 секунды
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Функция очистки
function cleanup() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    cleanupSignalingChannels();
    
    if (roomTimeout) {
        clearTimeout(roomTimeout);
        roomTimeout = null;
    }
    
    if (activityCheckInterval) {
        clearInterval(activityCheckInterval);
        activityCheckInterval = null;
    }
    
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    
    callStartTime = null;
    currentRoom = null;
}

// Обработчики для отслеживания закрытия вкладки
window.addEventListener('beforeunload', async (e) => {
    if (currentRoom) {
        // Предотвращаем немедленное закрытие для отправки данных
        e.preventDefault();
        e.returnValue = '';
        
        // Используем sendBeacon для надежной отправки данных при закрытии
        const data = new Blob([JSON.stringify({
            room_number: currentRoom,
            user_id: userId,
            action: 'leave'
        })], { type: 'application/json' });
        
        navigator.sendBeacon('/api/leave-room', data);
        
        // Также выполняем обычный выход
        await leaveRoom();
    }
});

window.addEventListener('pagehide', async () => {
    if (currentRoom) {
        await leaveRoom();
    }
});

// Обработчик видимости страницы
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        // Пользователь вернулся на вкладку
        updateActivity();
    }
});

// Проверка поддержки WebRTC
function checkWebRTCAvailability() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('Ваш браузер не поддерживает WebRTC или доступ к медиаустройствам');
        return false;
    }
    
    if (!window.RTCPeerConnection) {
        showError('Ваш браузер не поддерживает WebRTC');
        return false;
    }
    
    return true;
}

// Инициализация проверки WebRTC
if (!checkWebRTCAvailability()) {
    roomForm.querySelector('button').disabled = true;
}

// Периодическая очистка неактивных комнат (дополнительная страховка)
setInterval(async () => {
    try {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        
        // Удаляем комнаты без активности более 10 минут
        const { error } = await supabase
            .from('rooms')
            .delete()
            .lt('last_activity', tenMinutesAgo);
        
        if (error) console.error('Ошибка автоматической очистки комнат:', error);
        
        // Также очищаем старые signaling данные
        await supabase
            .from('signaling')
            .delete()
            .lt('created_at', tenMinutesAgo);
            
    } catch (error) {
        console.error('Ошибка автоматической очистки комнат:', error);
    }
}, 5 * 60 * 1000); // Проверка каждые 5 минут

console.log('Online Call App инициализирован');
