import * as React from 'react';
import { useRef, useState, useContext } from 'react';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { LuAlertTriangle, LuDownload, LuUpload } from 'react-icons/lu';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { apiFetcher } from '../../utils/fetch';
import { StoreContext } from '../../store';
import config from '../../config';

const CHUNK_SIZE = 5; // Process 5 payments at a time

export default function BulkPaymentUpload({ isOpen, onClose, onSuccess }) {
  const { t } = useTranslation('common');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [currentStatus, setCurrentStatus] = useState('');
  const [error, setError] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const fileInputRef = useRef(null);
  const store = useContext(StoreContext);
  const [lastProcessedIndex, setLastProcessedIndex] = useState(0);

  const handleFileChange = (event) => {
    const selectedFile = event.target.files[0];
    if (selectedFile && selectedFile.type === 'text/csv') {
      setFile(selectedFile);
    } else {
      toast.error(t('Please select a valid CSV file'));
      event.target.value = null;
    }
  };

  const handleDownloadTemplate = () => {
    const headers = ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount'];
    const csvContent = headers.join(',') + '\n' + 
      '026551,09/01/2024,Mpesa,SI171M8709,5600\n' +  // Example row
      '046006,09/01/2024,Mpesa,SI121QSOR6,2000';     // Another example row
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'payment_upload_template.csv';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const ensureValidToken = async () => {
    let refreshResult;
    try {
      refreshResult = await store.user.refreshTokens();
      if (refreshResult.status !== 200) {
        throw new Error('Token refresh failed: ' + (refreshResult.error?.message || 'Unknown error'));
      }
      console.log('Tokens refreshed successfully');
      return store.user.token;
    } catch (refreshError) {
      console.error('Initial token refresh failed:', refreshError);
      toast.error(t('Authentication error. Please log in again.'));
      window.location.assign(`${config.BASE_PATH}`);
      return null;
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error(t('Please select a file first'));
      return;
    }

    setLoading(true);
    setUploadProgress(0);
    setProcessingProgress(0);
    setCurrentStatus('uploading');
    setStatusMessage('');
    setError(null);

    try {
      // Get valid token
      const validToken = await ensureValidToken();
      if (!validToken) {
        setError('Authentication failed');
        setLoading(false);
        return;
      }

      // Create form data with the file
      const formData = new FormData();
      formData.append('file', file);
      // Get current term from store or URL
      const currentTerm = store.rent.periodAsString;
      formData.append('term', currentTerm);

      // Create a promise that wraps XMLHttpRequest to track progress
      const uploadWithProgress = () => {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          
          let lastResponseLength = 0;
          let buffer = '';
          let isCompleted = false;

          // Track upload progress
          xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
              const progress = Math.round((event.loaded * 100) / event.total);
              setUploadProgress(progress);
              setStatusMessage(`Uploading... ${progress}%`);
            }
          });

          // Handle upload complete
          xhr.upload.addEventListener('load', () => {
            console.log('File upload completed, waiting for processing...');
            setStatusMessage('Upload complete. Processing file...');
            setProcessingProgress(0);
          });
          
          // Handle the SSE response (processing progress)
          xhr.addEventListener('readystatechange', () => {
            try {
              if (xhr.readyState === 3 || xhr.readyState === 4) {
                const responseText = xhr.responseText;
                const newResponse = responseText.substring(lastResponseLength);
                lastResponseLength = responseText.length;
                
                if (!newResponse) return;
                
                console.log('Received new response chunk:', newResponse);
                
                // Add new data to our buffer
                buffer += newResponse;
                
                // Split buffer by newlines and process each line
                const lines = buffer.split('\n');
                // Keep the last line in buffer as it might be incomplete
                buffer = lines.pop() || '';
                
                // Process complete lines
                for (const line of lines) {
                  if (!line.trim()) continue;
                  
                  try {
                    console.log('Processing line:', line);
                    const event = JSON.parse(line);
                    console.log('Parsed event:', event);
                    
                    if (event.status === 'processing') {
                      setCurrentStatus('processing');
                      const progress = typeof event.progress === 'number' ? event.progress : 0;
                      setProcessingProgress(progress);
                      setStatusMessage(event.message || `Processing payments... ${progress}%`);
                    } else if (event.status === 'complete') {
                      console.log('Received completion event');
                      isCompleted = true;
                      setCurrentStatus('complete');
                      setProcessingProgress(100);
                      setStatusMessage(event.message || 'Processing complete');
                      
                      // Show success message
                      toast.success(event.message || 'All payments processed successfully');
                      
                      // Close dialog after short delay
                      setTimeout(() => {
                        if (onSuccess && typeof onSuccess === 'function') {
                          onSuccess(event);
                        }
                        if (onClose && typeof onClose === 'function') {
                          onClose();
                        }
                      }, 1000);
                      
                      resolve(event);
                    } else if (event.status === 'error') {
                      console.error('Received error event:', event);
                      setCurrentStatus('error');
                      const errorMsg = event.message || 'Error processing file';
                      setStatusMessage(errorMsg);
                      setError(errorMsg);
                      toast.error(errorMsg);
                      reject(new Error(errorMsg));
                    }
                  } catch (parseError) {
                    console.log('Parse error for line:', line, parseError);
                    // Only log parse errors if we're not at the end of processing
                    if (!(xhr.readyState === 4 && xhr.status === 200)) {
                      console.error('Parse error details:', parseError);
                    }
                  }
                }

                // Handle completion when request is done
                if (xhr.readyState === 4 && xhr.status === 200 && !isCompleted) {
                  console.log('Request completed without explicit completion event');
                  setCurrentStatus('complete');
                  setProcessingProgress(100);
                  setStatusMessage('Processing complete');
                  toast.success('All payments processed successfully');
                  setTimeout(() => {
                    if (onSuccess && typeof onSuccess === 'function') {
                      onSuccess({});
                    }
                    if (onClose && typeof onClose === 'function') {
                      onClose();
                    }
                  }, 1000);
                  resolve({});
                }
              }
            } catch (error) {
              console.error('Error processing response:', error);
              setError('Error processing server response');
              reject(error);
            }
          });

          // Handle request completion
          xhr.addEventListener('load', () => {
            console.log('XHR load event, status:', xhr.status);
            if (xhr.status >= 200 && xhr.status < 300) {
              if (!isCompleted) {
                console.log('Request completed successfully without completion event');
                setStatusMessage('Processing complete');
                setCurrentStatus('complete');
                setProcessingProgress(100);
                setTimeout(() => {
                  if (onSuccess && typeof onSuccess === 'function') {
                    onSuccess({});
                  }
                  if (onClose && typeof onClose === 'function') {
                    onClose();
                  }
                }, 1000);
                resolve();
              }
            } else {
              const errorMsg = 'Upload failed';
              console.error('Upload failed with status:', xhr.status);
              setCurrentStatus('error');
              setStatusMessage(errorMsg);
              setError(errorMsg);
              toast.error(errorMsg);
              reject(new Error(errorMsg));
            }
          });

          // Send the request
          try {
            xhr.open('POST', `${config.BASE_PATH}/api/paymentprocessor/process-payments`);
            xhr.setRequestHeader('Authorization', `Bearer ${validToken}`);
            xhr.setRequestHeader('organizationid', store.organization?.selected?._id);
            xhr.send(formData);
          } catch (error) {
            const errorMsg = 'Failed to start upload';
            setCurrentStatus('error');
            setStatusMessage(errorMsg);
            setError(errorMsg);
            toast.error(errorMsg);
            reject(error);
          }
        });
      };

      // Execute the upload
      await uploadWithProgress();
    } catch (error) {
      console.error('Upload error:', error);
      setError(error.message || 'An error occurred during upload');
      toast.error(error.message || 'An error occurred during upload');
    } finally {
      if (currentStatus !== 'complete') {
        setLoading(false);
      }
    }
  };

  const getProgressValue = () => {
    if (currentStatus === 'uploading') {
      return uploadProgress;
    } else if (currentStatus === 'processing') {
      return processingProgress;
    } else if (currentStatus === 'complete') {
      return 100;
    }
    return 0;
  };

  const getProgressText = () => {
    if (currentStatus === 'uploading') {
      return `Uploading... ${uploadProgress}%`;
    } else if (currentStatus === 'processing') {
      return `Processing payments... ${processingProgress}%`;
    } else if (currentStatus === 'complete') {
      return 'Processing complete';
    } else if (currentStatus === 'error') {
      return statusMessage || 'Error occurred';
    }
    return 'Ready to upload';
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Upload Bulk Payments')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Alert variant="info" className="text-sm">
            <LuAlertTriangle className="h-4 w-4" />
            <div>
              <p>{t('Please ensure your CSV file follows the required format.')}</p>
              <p>{t('Download the template below for reference.')}</p>
            </div>
          </Alert>

          <div className="flex flex-col gap-4">
            <Button
              variant="outline"
              onClick={handleDownloadTemplate}
              className="w-full"
            >
              <LuDownload className="mr-2 h-4 w-4" />
              {t('Download Template')}
            </Button>

            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              ref={fileInputRef}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <LuUpload className="mr-2 h-4 w-4" />
              {t('Select CSV File')}
            </Button>
            {file && (
              <p className="text-sm text-gray-500">
                {t('Selected file')}: {file.name}
              </p>
            )}

            {loading && (getProgressValue() > 0) && (
              <div className="space-y-2">
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                    style={{ width: `${getProgressValue()}%` }}
                  ></div>
                </div>
                <p className="text-sm text-center text-gray-600">
                  {statusMessage || getProgressText()}
                </p>
              </div>
            )}

            <Button
              onClick={handleUpload}
              disabled={!file || loading}
              className="w-full"
            >
              {loading ? getProgressText() : t('Upload Payments')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
