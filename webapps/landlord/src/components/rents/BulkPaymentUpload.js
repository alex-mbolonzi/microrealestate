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

    try {
      // Ensure we have a valid token before starting the upload
      const token = await ensureValidToken();
      if (!token) {
        throw new Error('Failed to get valid token');
      }

      // Create form data with the file and term
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
          
          // Track upload progress
          xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
              const progress = Math.round((event.loaded * 100) / event.total);
              setCurrentStatus('uploading');
              setUploadProgress(progress);
              setStatusMessage(`Uploading... ${progress}%`);
            }
          });
          
          // Handle the SSE response (processing progress)
          xhr.addEventListener('progress', () => {
            const responseText = xhr.responseText;
            
            // Get only the new portion of the response
            const newResponse = responseText.substring(lastResponseLength);
            lastResponseLength = responseText.length;
            
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
                const event = JSON.parse(line);
                
                // Update UI based on event status
                if (event.status === 'processing') {
                  setCurrentStatus('processing');
                  setProcessingProgress(event.progress || 0);
                  setStatusMessage(event.message || `Processing... ${event.progress}%`);
                } else if (event.status === 'complete') {
                  setCurrentStatus('complete');
                  setProcessingProgress(100);
                  setStatusMessage(event.message || 'Processing complete');
                  buffer = ''; // Clear buffer on completion
                  resolve(event);
                } else if (event.status === 'error') {
                  setCurrentStatus('error');
                  setStatusMessage(event.message || 'Error processing file');
                  buffer = ''; // Clear buffer on error
                  reject(new Error(event.message));
                }
              } catch (parseError) {
                console.error('Parse error for line:', line);
                console.error('Parse error details:', parseError);
              }
            }
          });

          // Handle request completion
          xhr.addEventListener('load', async () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              // Success - the 'progress' event handler will resolve the promise
            } else {
              setCurrentStatus('error');
              setStatusMessage('Upload failed');
              reject(new Error('Upload failed'));
            }
          });

          xhr.addEventListener('error', () => {
            setCurrentStatus('error');
            setStatusMessage('Network error occurred');
            reject(new Error('Network error'));
          });

          xhr.addEventListener('abort', () => {
            setCurrentStatus('error');
            setStatusMessage('Upload cancelled');
            reject(new Error('Upload cancelled'));
          });

          // Send the request
          try {
            xhr.open('POST', `${config.BASE_PATH}/api/paymentprocessor/process-payments`);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.setRequestHeader('organizationid', store.organization?.selected?._id);
            xhr.send(formData);
          } catch (error) {
            setCurrentStatus('error');
            setStatusMessage('Failed to start upload');
            reject(error);
          }
        });
      };

      // Execute the upload
      console.log('Request details:', {
        url: `${config.BASE_PATH}/api/paymentprocessor/process-payments`,
        organizationId: store.organization?.selected?._id,
        fileSize: file.size,
        fileName: file.name
      });

      const responseData = await uploadWithProgress();
      
      // Calculate statistics
      const total = responseData.summary?.total || 0;
      const successful = responseData.summary?.successful || 0;
      const failed = responseData.summary?.failed || 0;

      // Create detailed error message for failed records
      let errorDetails = '';
      if (failed > 0) {
        const failedRecords = responseData.results
          .filter(r => !r.success)
          .map(r => {
            // Parse error message if it's a JSON string
            let errorMessage = r.message;
            try {
              const parsedError = JSON.parse(r.message.match(/\{.*\}/)?.[0] || '{}');
              if (parsedError.message) {
                errorMessage = parsedError.message;
              }
            } catch (e) {
              // Keep original message if parsing fails
            }
            return `\n• Tenant ${r.tenant_id}: ${errorMessage}`;
          })
          .join('');
        errorDetails = `\n\nFailed records:${failedRecords}`;
      }

      // Show summary with details
      if (failed > 0) {
        toast.error(
          t('Upload completed with errors: {{successful}} successful, {{failed}} failed.{{details}}', {
            successful,
            failed,
            details: errorDetails
          })
        );
      } else {
        toast.success(
          t('Upload completed successfully: {{total}} payments processed', {
            total
          })
        );
      }

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Upload error:', error);
      toast.error(error.message || t('Failed to upload file'));
    } finally {
      setLoading(false);
      setUploadProgress(0);
      setProcessingProgress(0);
      setCurrentStatus('');
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = null;
      }
    }
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
      return `Processing... ${processingProgress}%`;
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
